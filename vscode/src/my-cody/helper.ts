import * as vscode from 'vscode'

export function constructFileUri(fileName: string, rootDirPath?: string): vscode.Uri | undefined {
    if (!rootDirPath) {
        return undefined
    }
    const rootDirUri = vscode.Uri.parse(rootDirPath)
    const codyJsonFilePath = vscode.Uri.joinPath(rootDirUri, fileName)
    return codyJsonFilePath
}

// Create a .vscode/cody.json file in the root directory of the workspace or user's home directory using the sample files
export async function createJSONFile(extensionPath: string, rootDirPath: string, isUserType: boolean): Promise<void> {
    const sampleFileName = isUserType ? 'user-cody.json' : 'workspace-cody.json'
    const codyJsonPath = constructFileUri('resources/samples/' + sampleFileName, extensionPath)
    if (!rootDirPath || !codyJsonPath) {
        void vscode.window.showErrorMessage('Failed to create cody.json file.')
        return
    }
    const bytes = await vscode.workspace.fs.readFile(codyJsonPath)
    const decoded = new TextDecoder('utf-8').decode(bytes)
    await saveJSONFile(decoded, rootDirPath)
}

// Add context from the sample files to the .vscode/cody.json file
export async function saveJSONFile(context: string, rootDirPath: string, isSaveMode = false): Promise<void> {
    const codyJsonFilePath = constructFileUri('.vscode/cody.json', rootDirPath)
    if (!codyJsonFilePath) {
        return
    }
    const workspaceEditor = new vscode.WorkspaceEdit()
    // Clear the file before writing to it
    workspaceEditor.deleteFile(codyJsonFilePath, { ignoreIfNotExists: true })
    workspaceEditor.createFile(codyJsonFilePath, { ignoreIfExists: isSaveMode })
    workspaceEditor.insert(codyJsonFilePath, new vscode.Position(0, 0), context)
    await vscode.workspace.applyEdit(workspaceEditor)
    // Save the file
    const doc = await vscode.workspace.openTextDocument(codyJsonFilePath)
    await doc.save()
    if (!isSaveMode) {
        await vscode.window.showTextDocument(codyJsonFilePath)
    }
}

// Create a file watcher for each .vscode/cody.json file
export function createFileWatch(fsPath?: string): vscode.FileSystemWatcher | null {
    if (!fsPath) {
        return null
    }
    const fileName = '.vscode/cody.json'
    const watchPattern = new vscode.RelativePattern(fsPath, fileName)
    const watcher = vscode.workspace.createFileSystemWatcher(watchPattern)
    return watcher
}

export async function deleteFile(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        return
    }
    await vscode.workspace.fs.delete(uri)
}

export const prompt_creation_title = 'Cody Custom Recipes - New Recipe'

export async function doesPathExist(filePath?: string): Promise<boolean> {
    try {
        return (filePath && !!(await vscode.workspace.fs.stat(vscode.Uri.file(filePath)))) || false
    } catch (error) {
        console.error('Failed to locate file', error)
        return false
    }
}

export function getFileNameFromPath(path: string): string | undefined {
    return path.split('/').pop()
}

export async function getFileToRemove(keys: string[]): Promise<string | undefined> {
    return vscode.window.showQuickPick(Array.from(keys))
}

export const outputWrapper = `
Here is the output of \`{command}\` command:
\`\`\`sh
{output}
\`\`\``
