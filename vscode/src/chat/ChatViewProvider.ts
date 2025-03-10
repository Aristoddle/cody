import { spawnSync } from 'child_process'
import path from 'path'

import * as vscode from 'vscode'

import { BotResponseMultiplexer } from '@sourcegraph/cody-shared/src/chat/bot-response-multiplexer'
import { ChatClient } from '@sourcegraph/cody-shared/src/chat/chat'
import { getPreamble } from '@sourcegraph/cody-shared/src/chat/preamble'
import { RecipeID } from '@sourcegraph/cody-shared/src/chat/recipes/recipe'
import { Transcript } from '@sourcegraph/cody-shared/src/chat/transcript'
import { ChatHistory, ChatMessage } from '@sourcegraph/cody-shared/src/chat/transcript/messages'
import { reformatBotMessage } from '@sourcegraph/cody-shared/src/chat/viewHelpers'
import { CodebaseContext } from '@sourcegraph/cody-shared/src/codebase-context'
import { ConfigurationWithAccessToken } from '@sourcegraph/cody-shared/src/configuration'
import { Editor } from '@sourcegraph/cody-shared/src/editor'
import { SourcegraphEmbeddingsSearchClient } from '@sourcegraph/cody-shared/src/embeddings/client'
import { annotateAttribution, Guardrails } from '@sourcegraph/cody-shared/src/guardrails'
import { highlightTokens } from '@sourcegraph/cody-shared/src/hallucinations-detector'
import { IntentDetector } from '@sourcegraph/cody-shared/src/intent-detector'
import * as plugins from '@sourcegraph/cody-shared/src/plugins/api'
import { PluginFunctionExecutionInfo } from '@sourcegraph/cody-shared/src/plugins/api/types'
import { defaultPlugins } from '@sourcegraph/cody-shared/src/plugins/built-in'
import { ANSWER_TOKENS, DEFAULT_MAX_TOKENS } from '@sourcegraph/cody-shared/src/prompt/constants'
import { Message } from '@sourcegraph/cody-shared/src/sourcegraph-api'
import { SourcegraphGraphQLAPIClient } from '@sourcegraph/cody-shared/src/sourcegraph-api/graphql'
import { isError } from '@sourcegraph/cody-shared/src/utils'

import { View } from '../../webviews/NavBar'
import { getFullConfig } from '../configuration'
import { VSCodeEditor } from '../editor/vscode-editor'
import { FilenameContextFetcher } from '../local-context/filename-context-fetcher'
import { LocalKeywordContextFetcher } from '../local-context/local-keyword-context-fetcher'
import { debug } from '../log'
import { getRerankWithLog } from '../logged-rerank'
import { FixupTask } from '../non-stop/FixupTask'
import { IdleRecipeRunner } from '../non-stop/roles'
import { AuthProvider } from '../services/AuthProvider'
import { logEvent } from '../services/EventLogger'
import { LocalStorage } from '../services/LocalStorageProvider'
import { SecretStorage } from '../services/SecretStorageProvider'
import { TestSupport } from '../test-support'

import { fastFilesExist } from './fastFileFinder'
import {
    ConfigurationSubsetForWebview,
    DOTCOM_URL,
    ExtensionMessage,
    isLocalApp,
    LocalEnv,
    WebviewMessage,
} from './protocol'
import { getRecipe } from './recipes'
import { convertGitCloneURLToCodebaseName } from './utils'

export type Config = Pick<
    ConfigurationWithAccessToken,
    | 'codebase'
    | 'serverEndpoint'
    | 'debugEnable'
    | 'debugFilter'
    | 'debugVerbose'
    | 'customHeaders'
    | 'accessToken'
    | 'useContext'
    | 'experimentalChatPredictions'
    | 'experimentalGuardrails'
    | 'experimentalCustomRecipes'
    | 'pluginsEnabled'
    | 'pluginsConfig'
    | 'pluginsDebugEnabled'
>

/**
 * The problem with a token limit for the prompt is that we can only
 * estimate tokens (and do so in a very cheap way), so it can be that
 * we undercount tokens. If we exceed the maximum tokens, things will
 * start to break, so we should have some safety cushion for when we're wrong in estimating.
 *
 * Ie.: Long text, 10000 characters, we estimate it to be 2500 tokens.
 * That would fit into a limit of 3000 tokens easily. Now, it's actually
 * 3500 tokens, because it splits weird and our estimation is off, it will
 * fail. That's where we want to add this safety cushion in.
 */
const SAFETY_PROMPT_TOKENS = 100

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, IdleRecipeRunner {
    private isMessageInProgress = false
    private cancelCompletionCallback: (() => void) | null = null
    public webview?: Omit<vscode.Webview, 'postMessage'> & {
        postMessage(message: ExtensionMessage): Thenable<boolean>
    }

    private currentChatID = ''
    private inputHistory: string[] = []
    private chatHistory: ChatHistory = {}

    private transcript: Transcript = new Transcript()

    // Allows recipes to hook up subscribers to process sub-streams of bot output
    private multiplexer: BotResponseMultiplexer = new BotResponseMultiplexer()

    // Fire event to let subscribers know that the configuration has changed
    public configurationChangeEvent = new vscode.EventEmitter<void>()

    private disposables: vscode.Disposable[] = []

    // Codebase-context-related state
    private currentWorkspaceRoot: string

    constructor(
        private extensionPath: string,
        private config: Omit<Config, 'codebase'>, // should use codebaseContext.getCodebase() rather than config.codebase
        private chat: ChatClient,
        private intentDetector: IntentDetector,
        private codebaseContext: CodebaseContext,
        private guardrails: Guardrails,
        private editor: VSCodeEditor,
        private secretStorage: SecretStorage,
        private localStorage: LocalStorage,
        private rgPath: string,
        private authProvider: AuthProvider
    ) {
        if (TestSupport.instance) {
            TestSupport.instance.chatViewProvider.set(this)
        }
        // chat id is used to identify chat session
        this.createNewChatID()
        this.disposables.push(this.configurationChangeEvent)

        this.currentWorkspaceRoot = ''

        // listen for vscode active editor change event
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(async () => {
                await this.updateCodebaseContext()
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                await this.updateCodebaseContext()
            }),
            vscode.commands.registerCommand('cody.auth.sync', () => this.syncAuthStatus())
        )
    }

    private idleCallbacks_: (() => void)[] = []

    private get isIdle(): boolean {
        // TODO: Use a cooldown timer for typing and interaction
        return !this.isMessageInProgress
    }

    private scheduleIdleRecipes(): void {
        setTimeout(() => {
            if (!this.isIdle) {
                // We rely on the recipe ending re-scheduling idle recipes
                return
            }
            const notifyIdle = this.idleCallbacks_.shift()
            if (!notifyIdle) {
                return
            }
            try {
                notifyIdle()
            } catch (error) {
                console.error(error)
            }
            if (this.idleCallbacks_.length) {
                this.scheduleIdleRecipes()
            }
        }, 1000)
    }

    public onIdle(callback: () => void): void {
        if (this.isIdle) {
            // Run "now", but not synchronously on this callstack.
            void Promise.resolve().then(callback)
        } else {
            this.idleCallbacks_.push(callback)
        }
    }

    public runIdleRecipe(recipeId: RecipeID, humanChatInput?: string): Promise<void> {
        if (!this.isIdle) {
            throw new Error('not idle')
        }
        return this.executeRecipe(recipeId, humanChatInput, false)
    }

    public onConfigurationChange(newConfig: Config): void {
        debug('ChatViewProvider:onConfigurationChange', '')
        this.config = newConfig
        const authStatus = this.authProvider.getAuthStatus()
        if (authStatus.endpoint) {
            this.config.serverEndpoint = authStatus.endpoint
        }
        void this.sendMyPrompts()
        this.configurationChangeEvent.fire()
    }

    public async clearAndRestartSession(): Promise<void> {
        await this.saveTranscriptToChatHistory()
        await this.setAnonymousUserID()
        this.createNewChatID()
        this.cancelCompletion()
        this.isMessageInProgress = false
        this.transcript.reset()
        this.sendSuggestions([])
        this.sendTranscript()
        this.sendChatHistory()
    }

    public async clearHistory(): Promise<void> {
        this.chatHistory = {}
        this.inputHistory = []
        await this.localStorage.removeChatHistory()
    }

    public async setAnonymousUserID(): Promise<void> {
        await this.localStorage.setAnonymousUserID()
    }

    /**
     * Restores a session from a chatID
     */
    public async restoreSession(chatID: string): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.cancelCompletion()
        this.currentChatID = chatID
        this.transcript = Transcript.fromJSON(this.chatHistory[chatID])
        await this.transcript.toJSON()
        this.sendTranscript()
        this.sendChatHistory()
    }

    private async onDidReceiveMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                // The web view is ready to receive events. We need to make sure that it has an up
                // to date config, even if it was already published
                await this.authProvider.announceNewAuthStatus()
                break
            case 'initialized':
                debug('ChatViewProvider:onDidReceiveMessage:initialized', '')
                this.loadChatHistory()
                this.sendTranscript()
                this.sendChatHistory()
                this.sendEnabledPlugins(this.localStorage.getEnabledPlugins() ?? [])
                await this.loadRecentChat()
                await this.publishContextStatus()
                await this.sendMyPrompts()
                break
            case 'submit':
                await this.onHumanMessageSubmitted(message.text, message.submitType)
                break
            case 'edit':
                this.transcript.removeLastInteraction()
                await this.onHumanMessageSubmitted(message.text, 'user')
                break
            case 'abort':
                this.cancelCompletion()
                await this.multiplexer.notifyTurnComplete()
                this.onCompletionEnd()
                break
            case 'executeRecipe':
                await this.executeRecipe(message.recipe)
                break
            case 'auth':
                if (message.type === 'app' && message.endpoint) {
                    await this.authProvider.appAuth(message.endpoint)
                    // Log app button click events: e.g. app:download:clicked or app:connect:clicked
                    this.sendEvent('click', message.value === 'download' ? 'app:download' : 'app:connect')
                    break
                }
                if (message.type === 'callback' && message.endpoint) {
                    await this.authProvider.redirectToEndpointLogin(message.endpoint)
                    break
                }
                // cody.auth.signin or cody.auth.signout
                await vscode.commands.executeCommand(`cody.auth.${message.type}`)
                break
            case 'settings':
                await this.authProvider.auth(message.serverEndpoint, message.accessToken, this.config.customHeaders)
                break
            case 'insert':
                await this.insertAtCursor(message.text)
                break
            case 'event':
                this.sendEvent(message.event, message.value)
                break
            case 'removeHistory':
                await this.clearHistory()
                break
            case 'restoreHistory':
                await this.restoreSession(message.chatID)
                break
            case 'deleteHistory':
                await this.deleteHistory(message.chatID)
                break
            case 'links':
                void this.openExternalLinks(message.value)
                break
            case 'my-prompt':
                await this.executeCustomRecipe(message.title)
                break
            case 'openFile': {
                const rootPath = this.editor.getWorkspaceRootPath()
                if (!rootPath) {
                    this.sendErrorToWebview('Failed to open file: missing rootPath')
                    return
                }
                try {
                    // This opens the file in the active column.
                    const uri = vscode.Uri.file(path.join(rootPath, message.filePath))
                    const doc = await vscode.workspace.openTextDocument(uri)
                    await vscode.window.showTextDocument(doc)
                } catch {
                    // Try to open the file in the sourcegraph view
                    const sourcegraphSearchURL = new URL(
                        `/search?q=context:global+file:${message.filePath}`,
                        this.config.serverEndpoint
                    ).href
                    void this.openExternalLinks(sourcegraphSearchURL)
                }
                break
            }
            case 'chat-button': {
                switch (message.action) {
                    case 'explain-code-high-level':
                    case 'find-code-smells':
                    case 'generate-unit-test':
                        void this.executeRecipe(message.action)
                        break
                    default:
                        break
                }
                break
            }
            case 'setEnabledPlugins':
                await this.localStorage.setEnabledPlugins(message.plugins)
                this.sendEnabledPlugins(message.plugins)
                break
            default:
                this.sendErrorToWebview('Invalid request type from Webview')
        }
    }

    private sendEnabledPlugins(plugins: string[]): void {
        void this.webview?.postMessage({ type: 'enabled-plugins', plugins })
    }

    private createNewChatID(): void {
        this.currentChatID = new Date(Date.now()).toUTCString()
    }

    private sendPrompt(promptMessages: Message[], responsePrefix = ''): void {
        this.cancelCompletion()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', true)
        this.editor.controllers.inline.setResponsePending(true)

        let text = ''

        this.multiplexer.sub(BotResponseMultiplexer.DEFAULT_TOPIC, {
            onResponse: (content: string) => {
                text += content
                const displayText = reformatBotMessage(text, responsePrefix)
                this.transcript.addAssistantResponse(displayText)
                this.editor.controllers.inline.reply(displayText, 'streaming')
                this.sendTranscript()
                return Promise.resolve()
            },
            onTurnComplete: async () => {
                const lastInteraction = this.transcript.getLastInteraction()
                if (lastInteraction) {
                    const displayText = reformatBotMessage(text, responsePrefix)
                    const fileExistFunc = (filePaths: string[]): Promise<{ [filePath: string]: boolean }> => {
                        const rootPath = this.editor.getWorkspaceRootPath()
                        if (!rootPath) {
                            return Promise.resolve({})
                        }
                        return fastFilesExist(this.rgPath, rootPath, filePaths)
                    }
                    let { text: highlightedDisplayText } = await highlightTokens(
                        displayText || '',
                        fileExistFunc,
                        this.currentWorkspaceRoot
                    )
                    // TODO(keegancsmith) guardrails may be slow, we need to make this async update the interaction.
                    highlightedDisplayText = await this.guardrailsAnnotateAttributions(highlightedDisplayText)
                    this.transcript.addAssistantResponse(text || '', highlightedDisplayText)
                    this.editor.controllers.inline.reply(highlightedDisplayText, 'complete')
                }
                void this.onCompletionEnd()
            },
        })

        let textConsumed = 0

        this.cancelCompletionCallback = this.chat.chat(promptMessages, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void this.multiplexer.publish(text)
            },
            onComplete: () => {
                void this.multiplexer.notifyTurnComplete()
            },
            onError: (err, statusCode) => {
                // TODO notify the multiplexer of the error
                debug('ChatViewProvider:onError', err)
                if (isAbortError(err)) {
                    return
                }
                // Log users out on unauth error
                if (statusCode && statusCode >= 400 && statusCode <= 410) {
                    this.authProvider
                        .auth(this.config.serverEndpoint, this.config.accessToken, this.config.customHeaders)
                        .catch(error => console.error(error))
                    debug('ChatViewProvider:onError:unauthUser', err, { verbose: { statusCode } })
                }
                // Display error message as assistant response
                this.transcript.addErrorAsAssistantResponse(err)
                // We ignore embeddings errors in this instance because we're already showing an
                // error message and don't want to overwhelm the user.
                this.onCompletionEnd(true)
                void this.editor.controllers.inline.error()
                console.error(`Completion request failed: ${err}`)
            },
        })
    }

    private cancelCompletion(): void {
        this.cancelCompletionCallback?.()
        this.cancelCompletionCallback = null
    }

    private onCompletionEnd(ignoreEmbeddingsError: boolean = false): void {
        this.isMessageInProgress = false
        this.cancelCompletionCallback = null
        this.sendTranscript()
        void this.saveTranscriptToChatHistory()
        this.sendChatHistory()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', false)
        this.editor.controllers.inline.setResponsePending(false)
        if (!ignoreEmbeddingsError) {
            this.logEmbeddingsSearchErrors()
        }
        this.scheduleIdleRecipes()
    }

    private async onHumanMessageSubmitted(text: string, submitType: 'user' | 'suggestion'): Promise<void> {
        debug('ChatViewProvider:onHumanMessageSubmitted', '', { verbose: { text, submitType } })
        if (submitType === 'suggestion') {
            logEvent('CodyVSCodeExtension:chatPredictions:used')
        }
        this.inputHistory.push(text)
        if (this.config.experimentalChatPredictions) {
            void this.runRecipeForSuggestion('next-questions', text)
        }
        await this.executeChatCommands(text, 'chat-question')
    }

    private async executeChatCommands(text: string, recipeID: RecipeID = 'chat-question'): Promise<void> {
        switch (true) {
            case /^\/o(pen)?/i.test(text):
                // open the user's ~/.vscode/cody.json file
                await this.editor.controllers.prompt.open(text.split(' ')[1])
                break
            case /^\/r(eset)?/i.test(text):
                await this.clearAndRestartSession()
                break
            case /^\/s(earch)?\s/i.test(text):
                await this.executeRecipe('context-search', text)
                break
            default:
                return this.executeRecipe(recipeID, text)
        }
    }

    private async updateCodebaseContext(): Promise<void> {
        if (!this.editor.getActiveTextEditor() && vscode.window.visibleTextEditors.length !== 0) {
            // these are ephemeral
            return
        }
        const workspaceRoot = this.editor.getWorkspaceRootPath()
        if (!workspaceRoot || workspaceRoot === '' || workspaceRoot === this.currentWorkspaceRoot) {
            return
        }
        this.currentWorkspaceRoot = workspaceRoot

        const codebaseContext = await getCodebaseContext(this.config, this.rgPath, this.editor, this.chat)
        if (!codebaseContext) {
            return
        }
        // after await, check we're still hitting the same workspace root
        if (this.currentWorkspaceRoot !== workspaceRoot) {
            return
        }

        this.codebaseContext = codebaseContext
        await this.publishContextStatus()
        this.editor.controllers.prompt.setCodebase(codebaseContext.getCodebase())
    }

    private async getPluginsContext(
        humanChatInput: string
    ): Promise<{ prompt?: Message[]; executionInfos?: PluginFunctionExecutionInfo[] }> {
        logEvent('CodyVSCodeExtension:getPluginsContext:used')
        const enabledPluginNames = this.localStorage.getEnabledPlugins() ?? []
        const enabledPlugins = defaultPlugins.filter(plugin => enabledPluginNames.includes(plugin.name))
        if (enabledPlugins.length === 0) {
            return {}
        }
        logEvent(
            'CodyVSCodeExtension:getPluginsContext:enabledPlugins',
            { names: enabledPluginNames },
            { names: enabledPluginNames }
        )

        this.transcript.addAssistantResponse('', 'Identifying applicable plugins...\n')
        this.sendTranscript()

        const { prompt: previousMessages } = await this.transcript.getPromptForLastInteraction(
            [],
            this.maxPromptTokens,
            [],
            true
        )

        try {
            logEvent('CodyVSCodeExtension:getPluginsContext:chooseDataSourcesUsed')
            const descriptors = await plugins.chooseDataSources(
                humanChatInput,
                this.chat,
                enabledPlugins,
                previousMessages
            )
            logEvent(
                'CodyVSCodeExtension:getPluginsContext:descriptorsFound',
                { count: descriptors.length },
                { count: descriptors.length }
            )
            if (descriptors.length !== 0) {
                this.transcript.addAssistantResponse(
                    '',
                    `Using ${descriptors
                        .map(descriptor => descriptor.pluginName)
                        .join(', ')} for additional context...\n`
                )
                this.sendTranscript()

                logEvent(
                    'CodyVSCodeExtension:getPluginsContext:runPluginFunctionsCalled',
                    {
                        count: descriptors.length,
                    },
                    {
                        count: descriptors.length,
                    }
                )
                return await plugins.runPluginFunctions(descriptors, this.config.pluginsConfig)
            }
        } catch (error) {
            console.error('Error getting plugin context', error)
        }
        return {}
    }

    public async executeRecipe(recipeId: RecipeID, humanChatInput = '', showTab = true): Promise<void> {
        debug('ChatViewProvider:executeRecipe', recipeId, { verbose: humanChatInput })
        if (this.isMessageInProgress) {
            this.sendErrorToWebview('Cannot execute multiple recipes. Please wait for the current recipe to finish.')
            return
        }

        const recipe = getRecipe(recipeId)
        if (!recipe) {
            debug('ChatViewProvider:executeRecipe', 'no recipe found')
            return
        }

        // Create a new multiplexer to drop any old subscribers
        this.multiplexer = new BotResponseMultiplexer()

        const interaction = await recipe.getInteraction(humanChatInput, {
            editor: this.editor,
            intentDetector: this.intentDetector,
            codebaseContext: this.codebaseContext,
            responseMultiplexer: this.multiplexer,
            firstInteraction: this.transcript.isEmpty,
        })
        if (!interaction) {
            return
        }
        this.isMessageInProgress = true
        this.transcript.addInteraction(interaction)

        if (showTab) {
            this.showTab('chat')
        }

        let pluginsPrompt: Message[] = []
        let pluginExecutionInfos: PluginFunctionExecutionInfo[] = []
        if (this.config.pluginsEnabled && recipeId === 'chat-question') {
            const result = await this.getPluginsContext(humanChatInput)
            pluginsPrompt = result?.prompt ?? []
            pluginExecutionInfos = result?.executionInfos ?? []
        }

        // Check whether or not to connect to LLM backend for responses
        // Ex: performing fuzzy / context-search does not require responses from LLM backend
        switch (recipeId) {
            case 'context-search':
                this.onCompletionEnd()
                break
            default: {
                this.sendTranscript()

                const myPremade = this.editor.controllers.prompt.getMyPrompts().premade
                const { prompt, contextFiles } = await this.transcript.getPromptForLastInteraction(
                    getPreamble(this.codebaseContext.getCodebase(), myPremade),
                    this.maxPromptTokens,
                    pluginsPrompt
                )
                this.transcript.setUsedContextFilesForLastInteraction(contextFiles, pluginExecutionInfos)
                this.sendPrompt(prompt, interaction.getAssistantMessage().prefix ?? '')
                await this.saveTranscriptToChatHistory()
            }
        }
        logEvent(`CodyVSCodeExtension:recipe:${recipe.id}:executed`)
    }

    private async runRecipeForSuggestion(recipeId: RecipeID, humanChatInput: string = ''): Promise<void> {
        const recipe = getRecipe(recipeId)
        if (!recipe) {
            return
        }

        const multiplexer = new BotResponseMultiplexer()
        const transcript = Transcript.fromJSON(await this.transcript.toJSON())

        const interaction = await recipe.getInteraction(humanChatInput, {
            editor: this.editor,
            intentDetector: this.intentDetector,
            codebaseContext: this.codebaseContext,
            responseMultiplexer: multiplexer,
            firstInteraction: this.transcript.isEmpty,
        })
        if (!interaction) {
            return
        }
        transcript.addInteraction(interaction)

        const myPremade = this.editor.controllers.prompt.getMyPrompts().premade
        const { prompt, contextFiles } = await transcript.getPromptForLastInteraction(
            getPreamble(this.codebaseContext.getCodebase(), myPremade),
            this.maxPromptTokens
        )
        transcript.setUsedContextFilesForLastInteraction(contextFiles)

        logEvent(`CodyVSCodeExtension:recipe:${recipe.id}:executed`)

        let text = ''
        multiplexer.sub(BotResponseMultiplexer.DEFAULT_TOPIC, {
            onResponse: (content: string) => {
                text += content
                return Promise.resolve()
            },
            onTurnComplete: () => {
                const suggestions = text
                    .split('\n')
                    .slice(0, 3)
                    .map(line => line.trim().replace(/^-/, '').trim())
                this.sendSuggestions(suggestions)
                return Promise.resolve()
            },
        })

        let textConsumed = 0
        this.chat.chat(prompt, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void multiplexer.publish(text)
            },
            onComplete: () => {
                void multiplexer.notifyTurnComplete()
            },
            onError: (error, statusCode) => {
                console.error(error, statusCode)
            },
        })
    }

    private async guardrailsAnnotateAttributions(text: string): Promise<string> {
        if (!this.config.experimentalGuardrails) {
            return text
        }

        const result = await annotateAttribution(this.guardrails, text)

        // Only log telemetry if we did work (ie had to annotate something).
        if (result.codeBlocks > 0) {
            const event = {
                codeBlocks: result.codeBlocks,
                duration: result.duration,
            }
            logEvent('CodyVSCodeExtension:guardrails:annotate', event, event)
        }

        return result.text
    }

    private showTab(tab: string): void {
        void vscode.commands.executeCommand('cody.chat.focus')
        void this.webview?.postMessage({ type: 'showTab', tab })
    }

    /**
     * Send transcript to webview
     */
    private sendTranscript(): void {
        void this.webview?.postMessage({
            type: 'transcript',
            messages: this.transcript.toChat(),
            isMessageInProgress: this.isMessageInProgress,
        })
    }

    private sendSuggestions(suggestions: string[]): void {
        void this.webview?.postMessage({
            type: 'suggestions',
            suggestions,
        })
    }

    public async executeCustomRecipe(title: string): Promise<void> {
        if (!this.config.experimentalCustomRecipes) {
            return
        }
        // Send prompt names to webview to display as recipe options
        if (!title || title === 'get') {
            await this.sendMyPrompts()
            return
        }
        // Create a new recipe
        if (title === 'menu') {
            await this.editor.controllers.prompt.menu()
            await this.sendMyPrompts()
            return
        }
        if (title === 'add-workspace-file' || title === 'add-user-file') {
            const fileType = title === 'add-workspace-file' ? 'workspace' : 'user'
            try {
                // copy the cody.json file from the extension path and move it to the workspace root directory
                await this.editor.controllers.prompt.addJSONFile(fileType)
            } catch (error) {
                void vscode.window.showErrorMessage(`Could not create a new cody.json file: ${error}`)
            }
            return
        }
        // Get prompt details from controller by title then execute prompt's command
        const prompt = this.editor.controllers.prompt.find(title)
        await this.editor.controllers.prompt.get('command')
        if (!prompt) {
            debug('executeCustomRecipe:noPrompt', title)
            return
        }
        if (!prompt.startsWith('/')) {
            this.showTab('chat')
        }
        await this.executeChatCommands(prompt, 'my-prompt')
    }

    /**
     * Send custom recipe names to webview
     */
    private async sendMyPrompts(): Promise<void> {
        const send = async (): Promise<void> => {
            await this.editor.controllers.prompt.refresh()
            const prompts = this.editor.controllers.prompt.getPromptList()
            void this.webview?.postMessage({
                type: 'my-prompts',
                prompts,
                isEnabled: this.config.experimentalCustomRecipes,
            })
        }
        const init = (): void => {
            this.editor.controllers.prompt.setMessager(send)
        }
        init()
        await send()
    }

    private async saveTranscriptToChatHistory(): Promise<void> {
        if (this.transcript.isEmpty) {
            return
        }
        this.chatHistory[this.currentChatID] = await this.transcript.toJSON()
        await this.saveChatHistory()
    }

    /**
     * Save chat history
     */
    private async saveChatHistory(): Promise<void> {
        const userHistory = {
            chat: this.chatHistory,
            input: this.inputHistory,
        }
        await this.localStorage.setChatHistory(userHistory)
    }

    /**
     * Save, verify, and sync authStatus between extension host and webview
     * activate extension when user has valid login
     */
    public async syncAuthStatus(): Promise<void> {
        const authStatus = this.authProvider.getAuthStatus()
        // Update config to the latest one and fire configure change event to update external services
        const newConfig = await getFullConfig(this.secretStorage, this.localStorage)
        if (authStatus.siteVersion) {
            // Update codebase context
            const codebaseContext = await getCodebaseContext(newConfig, this.rgPath, this.editor, this.chat)
            if (codebaseContext) {
                this.codebaseContext = codebaseContext
            }
        }
        await this.publishConfig()
        this.onConfigurationChange(newConfig)
        // When logged out, user's endpoint will be set to null
        const isLoggedOut = !authStatus.isLoggedIn && !authStatus.endpoint
        const isAppEvent = isLocalApp(authStatus.endpoint || '') ? 'app:' : ''
        const eventValue = isLoggedOut ? 'disconnected' : authStatus.isLoggedIn ? 'connected' : 'failed'
        // e.g. auth:app:connected, auth:app:disconnected, auth:failed
        this.sendEvent('auth', isAppEvent + eventValue)
    }

    /**
     * Delete history from current chat history and local storage
     */
    private async deleteHistory(chatID: string): Promise<void> {
        delete this.chatHistory[chatID]
        await this.localStorage.deleteChatHistory(chatID)
        this.sendChatHistory()
    }

    /**
     * Loads chat history from local storage
     */
    private loadChatHistory(): void {
        const localHistory = this.localStorage.getChatHistory()
        if (localHistory) {
            this.chatHistory = localHistory?.chat
            this.inputHistory = localHistory.input
        }
    }

    /**
     * Loads the most recent chat
     */
    private async loadRecentChat(): Promise<void> {
        const localHistory = this.localStorage.getChatHistory()
        if (localHistory) {
            const chats = localHistory.chat
            const sortedChats = Object.entries(chats).sort(
                (a, b) => +new Date(b[1].lastInteractionTimestamp) - +new Date(a[1].lastInteractionTimestamp)
            )
            const chatID = sortedChats[0][0]
            await this.restoreSession(chatID)
        }
    }

    /**
     * Sends chat history to webview
     */
    private sendChatHistory(): void {
        void this.webview?.postMessage({
            type: 'history',
            messages: {
                chat: this.chatHistory,
                input: this.inputHistory,
            },
        })
    }

    /**
     * Publish the current context status to the webview.
     */
    private async publishContextStatus(): Promise<void> {
        const send = async (): Promise<void> => {
            const editorContext = this.editor.getActiveTextEditor()
            await this.webview?.postMessage({
                type: 'contextStatus',
                contextStatus: {
                    mode: this.config.useContext,
                    connection: this.codebaseContext.checkEmbeddingsConnection(),
                    codebase: this.codebaseContext.getCodebase(),
                    filePath: editorContext ? vscode.workspace.asRelativePath(editorContext.filePath) : undefined,
                    selection: editorContext ? editorContext.selection : undefined,
                    supportsKeyword: true,
                },
            })
        }

        this.disposables.push(this.configurationChangeEvent.event(() => send()))
        this.disposables.push(vscode.window.onDidChangeTextEditorSelection(() => send()))
        await send()
    }

    /**
     * Send embedding connections or results error to output
     */
    private logEmbeddingsSearchErrors(): void {
        if (this.config.useContext !== 'embeddings') {
            return
        }
        const searchErrors = this.codebaseContext.getEmbeddingSearchErrors()
        // Display error message as assistant response for users with indexed codebase but getting search errors
        if (this.codebaseContext.checkEmbeddingsConnection() && searchErrors) {
            this.transcript.addErrorAsAssistantResponse(searchErrors)
            debug('ChatViewProvider:onLogEmbeddingsErrors', '', { verbose: searchErrors })
        }
    }

    /**
     * Publish the config to the webview.
     */
    private async publishConfig(): Promise<void> {
        const send = async (): Promise<void> => {
            this.config = await getFullConfig(this.secretStorage, this.localStorage)

            // check if the new configuration change is valid or not
            const authStatus = this.authProvider.getAuthStatus()
            const localProcess = await this.authProvider.appDetector.getProcessInfo(authStatus.isLoggedIn)
            const configForWebview: ConfigurationSubsetForWebview & LocalEnv = {
                ...localProcess,
                debugEnable: this.config.debugEnable,
                serverEndpoint: this.config.serverEndpoint,
                pluginsEnabled: this.config.pluginsEnabled,
                pluginsDebugEnabled: this.config.pluginsDebugEnabled,
            }

            // update codebase context on configuration change
            await this.updateCodebaseContext()
            await this.webview?.postMessage({ type: 'config', config: configForWebview, authStatus })
            debug('Cody:publishConfig', 'configForWebview', { verbose: configForWebview })
        }

        await send()
    }

    /**
     * Log Events - naming convention: source:feature:action
     */
    public sendEvent(event: string, value: string): void {
        const endpoint = this.config.serverEndpoint || DOTCOM_URL.href
        const endpointUri = { serverEndpoint: endpoint }
        switch (event) {
            case 'feedback':
                logEvent(`CodyVSCodeExtension:codyFeedback:${value}`, null, this.codyFeedbackPayload())
                break
            case 'token':
                logEvent(`CodyVSCodeExtension:cody${value}AccessToken:clicked`, endpointUri, endpointUri)
                break
            case 'auth':
                logEvent(`CodyVSCodeExtension:Auth:${value}`, endpointUri, endpointUri)
                break
            case 'click':
                logEvent(`CodyVSCodeExtension:${value}:clicked`, endpointUri, endpointUri)
                break
        }
    }

    private codyFeedbackPayload(): { chatTranscript: ChatMessage[] | null; lastChatUsedEmbeddings: boolean } | null {
        const endpoint = this.config.serverEndpoint || DOTCOM_URL.href
        const isPrivateInstance = new URL(endpoint).href !== DOTCOM_URL.href

        // The user should only be able to submit feedback on transcripts, but just in case we guard against this happening.
        const privateChatTranscript = this.transcript.toChat()
        if (privateChatTranscript.length === 0) {
            return null
        }

        const lastContextFiles = privateChatTranscript.at(-1)?.contextFiles
        const lastChatUsedEmbeddings = lastContextFiles
            ? lastContextFiles.some(file => file.source === 'embeddings')
            : false

        // We only include full chat transcript for dot com users with connected codebase
        const chatTranscript = !isPrivateInstance && this.codebaseContext.getCodebase() ? privateChatTranscript : null

        return {
            chatTranscript,
            lastChatUsedEmbeddings,
        }
    }

    /**
     * Display error message in webview view as banner in chat view
     * It does not display error message as assistant response
     */
    public sendErrorToWebview(errorMsg: string): void {
        void this.webview?.postMessage({ type: 'errors', errors: errorMsg })
    }

    /**
     * Insert text at cursor position
     * Replace selection if there is one
     * Note: Using workspaceEdit instead of 'editor.action.insertSnippet' as the later reformats the text incorrectly
     */
    private async insertAtCursor(text: string): Promise<void> {
        const selectionRange = vscode.window.activeTextEditor?.selection
        const editor = vscode.window.activeTextEditor
        if (!editor || !selectionRange) {
            return
        }
        const edit = new vscode.WorkspaceEdit()
        // trimEnd() to remove new line added by Cody
        edit.replace(editor.document.uri, selectionRange, text.trimEnd())
        await vscode.workspace.applyEdit(edit)
    }

    /**
     * Set webview view
     */
    public setWebviewView(view: View): void {
        void vscode.commands.executeCommand('cody.chat.focus')
        void this.webview?.postMessage({
            type: 'view',
            messages: view,
        })
    }

    /**
     * create webview resources
     */
    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _context: vscode.WebviewViewResolveContext<unknown>,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.webview = webviewView.webview
        this.authProvider.webview = webviewView.webview

        const extensionPath = vscode.Uri.file(this.extensionPath)
        const webviewPath = vscode.Uri.joinPath(extensionPath, 'dist', 'webviews')

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        // Create Webview using vscode/index.html
        const root = vscode.Uri.joinPath(webviewPath, 'index.html')
        const bytes = await vscode.workspace.fs.readFile(root)
        const decoded = new TextDecoder('utf-8').decode(bytes)
        const resources = webviewView.webview.asWebviewUri(webviewPath)

        // Set HTML for webview
        // This replace variables from the vscode/dist/index.html with webview info
        // 1. Update URIs to load styles and scripts into webview (eg. path that starts with ./)
        // 2. Update URIs for content security policy to only allow specific scripts to be run
        webviewView.webview.html = decoded
            .replaceAll('./', `${resources.toString()}/`)
            .replaceAll('{cspSource}', webviewView.webview.cspSource)

        // Register webview
        this.disposables.push(webviewView.webview.onDidReceiveMessage(message => this.onDidReceiveMessage(message)))
    }

    /**
     * Open external links
     */
    private async openExternalLinks(uri: string): Promise<void> {
        try {
            await vscode.env.openExternal(vscode.Uri.parse(uri))
        } catch (error) {
            throw new Error(`Failed to open file: ${error}`)
        }
    }

    public transcriptForTesting(testing: TestSupport): ChatMessage[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        return this.transcript.toChat()
    }

    public fixupTasksForTesting(testing: TestSupport): FixupTask[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        return this.editor.controllers.fixups.getTasks()
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposables = []
    }

    private get maxPromptTokens(): number {
        const authStatus = this.authProvider.getAuthStatus()

        const codyConfig = vscode.workspace.getConfiguration('cody')
        const tokenLimit = codyConfig.get<number>('provider.limit.prompt')
        const localSolutionLimit = codyConfig.get<number>('provider.limit.solution')

        // The local config takes precedence over the server config.
        if (tokenLimit && localSolutionLimit) {
            return tokenLimit - localSolutionLimit
        }

        const solutionLimit = (localSolutionLimit || ANSWER_TOKENS) + SAFETY_PROMPT_TOKENS

        if (authStatus.configOverwrites?.chatModelMaxTokens) {
            return authStatus.configOverwrites.chatModelMaxTokens - solutionLimit
        }

        return DEFAULT_MAX_TOKENS - solutionLimit
    }
}

/**
 * Gets codebase context for the current workspace.
 *
 * @param config Cody configuration
 * @param rgPath Path to rg (ripgrep) executable
 * @param editor Editor instance
 * @returns CodebaseContext if a codebase can be determined, else null
 */
export async function getCodebaseContext(
    config: Config,
    rgPath: string,
    editor: Editor,
    chatClient: ChatClient
): Promise<CodebaseContext | null> {
    const client = new SourcegraphGraphQLAPIClient(config)
    const workspaceRoot = editor.getWorkspaceRootPath()
    if (!workspaceRoot) {
        return null
    }
    const gitCommand = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: workspaceRoot })
    const gitOutput = gitCommand.stdout.toString().trim()
    // Get codebase from config or fallback to getting repository name from git clone URL
    const codebase = config.codebase || convertGitCloneURLToCodebaseName(gitOutput)
    if (!codebase) {
        return null
    }
    // Check if repo is embedded in endpoint
    const repoId = await client.getRepoIdIfEmbeddingExists(codebase)
    if (isError(repoId)) {
        const infoMessage = `Cody could not find embeddings for '${codebase}' on your Sourcegraph instance.\n`
        console.info(infoMessage)
        return null
    }

    const embeddingsSearch = repoId && !isError(repoId) ? new SourcegraphEmbeddingsSearchClient(client, repoId) : null
    return new CodebaseContext(
        config,
        codebase,
        embeddingsSearch,
        new LocalKeywordContextFetcher(rgPath, editor, chatClient),
        new FilenameContextFetcher(rgPath, editor, chatClient),
        undefined,
        getRerankWithLog(chatClient)
    )
}

function isAbortError(error: string): boolean {
    return error === 'aborted' || error === 'socket hang up'
}
