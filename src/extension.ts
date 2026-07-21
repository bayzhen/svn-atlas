import * as vscode from "vscode";
import { SvnClient } from "./core/SvnClient";
import { LocalBaseQuickDiff } from "./quickDiff/LocalBaseQuickDiff";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("SVN Atlas");
  const svn = new SvnClient(() => {
    return vscode.workspace.getConfiguration("svnAtlas").get<string>("executablePath", "svn");
  });
  const quickDiff = new LocalBaseQuickDiff(svn, output);

  context.subscriptions.push(
    output,
    quickDiff,
    vscode.commands.registerCommand("svnAtlas.refreshLocalBase", async () => {
      const refreshed = await quickDiff.refreshAll();
      void vscode.window.showInformationMessage(`SVN Atlas refreshed ${refreshed} local BASE file(s).`);
    }),
    vscode.commands.registerCommand("svnAtlas.showOutput", () => output.show(true)),
  );

  output.appendLine("SVN Atlas activated: local BASE Quick Diff is ready.");
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}
