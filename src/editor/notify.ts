import * as vscode from "vscode";

/**
 * PLL's notifications, each starting with whose it is - a pop-up in the
 * corner says nothing about which extension raised it. The one place the
 * prefix is written.
 */
const PREFIX = "Python Language Levels: ";

export function showInfo<T extends string>(text: string, ...actions: T[]): Thenable<T | undefined> {
  return vscode.window.showInformationMessage(PREFIX + text, ...actions);
}

export function showWarning<T extends string>(text: string, ...actions: T[]): Thenable<T | undefined> {
  return vscode.window.showWarningMessage(PREFIX + text, ...actions);
}

export function showError(text: string): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(PREFIX + text);
}
