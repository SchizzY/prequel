// Choosing a folder with the operating system's own dialog.
//
// A browser will not tell a page where a folder lives on disk -- both
// <input webkitdirectory> and showDirectoryPicker() hand back names, never
// paths -- and a path is exactly what git needs. prequel already runs on the
// machine you are sitting at, so it opens the real dialog there instead of
// making you type the path or clicking through a list of directories.

import { execFile } from 'node:child_process';

// A dialog sits open for as long as it takes to find the folder; five minutes
// is "you walked away", not "you are still looking".
const TIMEOUT = 5 * 60 * 1000;

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT, windowsHide: true }, (err, stdout) => {
      const picked = String(stdout || '').trim();
      if (picked) return resolve(picked);
      // Cancelling exits non-zero (osascript) or prints nothing (the rest).
      // Neither is a failure: it is an answer of "never mind".
      resolve(err && err.code === 'ENOENT' ? { unavailable: true } : null);
    });
  });
}

// PowerShell's folder browser, owned by a topmost form so it opens in front of
// the browser rather than behind it.
const windowsScript = (start) => `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a git repository'
$dialog.ShowNewFolderButton = $false
${start ? `$dialog.SelectedPath = '${start.replace(/'/g, "''")}'` : ''}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
$owner.Dispose()
`;

const macScript = (start) =>
  'tell application "System Events" to activate\n' +
  'POSIX path of (choose folder with prompt "Choose a git repository"' +
  (start ? ` default location POSIX file ${JSON.stringify(start)}` : '') +
  ')';

/**
 * The folder the person picked, or null if they cancelled.
 * Resolves to `{ unavailable: true }` where no dialog can be shown -- a
 * headless Linux box, say -- so the caller can offer to take a typed path
 * instead of pretending the machine has no folders.
 */
export async function pickFolder({ start = null } = {}) {
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-STA', '-Command', windowsScript(start)]);
  }
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', macScript(start)]);
  }
  const zenity = await run('zenity', [
    '--file-selection',
    '--directory',
    '--title=Choose a git repository',
    ...(start ? [`--filename=${start}/`] : []),
  ]);
  if (!zenity?.unavailable) return zenity;
  const kdialog = await run('kdialog', ['--getexistingdirectory', start || '.']);
  return kdialog;
}
