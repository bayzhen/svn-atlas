import * as vscode from "vscode";
import { BaseBlameContentProvider } from "./blame/BaseBlameContentProvider";
import { SvnClient } from "./core/SvnClient";
import { LocalBaseQuickDiff } from "./quickDiff/LocalBaseQuickDiff";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("SVN Atlas");
  const svn = new SvnClient(() => {
    return vscode.workspace.getConfiguration("svnAtlas").get<string>("executablePath", "svn");
  });
  const quickDiff = new LocalBaseQuickDiff(svn, output);
  const baseBlame = new BaseBlameContentProvider(svn, output);

  context.subscriptions.push(
    output,
    quickDiff,
    baseBlame,
    vscode.commands.registerCommand("svnAtlas.refreshLocalBase", async () => {
      const refreshed = await quickDiff.refreshAll();
      baseBlame.clear();
      void vscode.window.showInformationMessage(`SVN Atlas refreshed ${refreshed} local BASE file(s) and invalidated BASE blame views.`);
    }),
    vscode.commands.registerCommand("svnAtlas.openBaseBlame", async () => {
      const editor = vscode.window.activeTextEditor;
      const resource = editor?.document.uri;
      if (!resource || resource.scheme !== "file") {
        void vscode.window.showWarningMessage("SVN Atlas BASE blame requires an open local file.");
        return;
      }

      try {
        const blameUri = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "SVN Atlas: Reading BASE blame",
          },
          () => baseBlame.open(resource),
        );
        const document = await vscode.workspace.openTextDocument(blameUri);
        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.languages.registerHoverProvider({ scheme: "file" }, {
      provideHover: async (document, position, token) => {
        if (!(await baseBlame.isWorkingCopy(document.uri))) {
          return undefined;
        }
        if (token.isCancellationRequested) {
          return undefined;
        }

        if (document.isDirty) {
          return new vscode.Hover("Save local edits before requesting BASE blame for this line.");
        }

        const blame = await baseBlame.getHoverInfo(document, position.line, token);
        if (token.isCancellationRequested) {
          return undefined;
        }
        if (!blame) {
          return undefined;
        }

        const message = new vscode.MarkdownString();
        message.appendMarkdown("**SVN BASE blame**  \n");
        message.appendMarkdown(`Revision: \`${blame.revision}\`  \n`);
        message.appendMarkdown(`Author: ${escapeMarkdown(blame.author)}  \n`);
        message.appendMarkdown(`Date: ${blame.date}  \n`);
        message.appendMarkdown(`BASE line: ${blame.baseLineNumber}`);
        return new vscode.Hover(message);
      },
    }),
    vscode.commands.registerCommand("svnAtlas.showOutput", () => output.show(true)),
  );

  output.appendLine("SVN Atlas activated: local BASE Quick Diff is ready.");
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>()#+.!|]/g, "\\$&");
}
