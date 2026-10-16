# Participant permissions and line comments — 0.6.7

Install 0.6.7 on every participant computer. For persistent server projects, update the server from the same release. Peer sessions use protocol v8 and reject incompatible older clients.

## Configure permissions

The P2P host selects **Права участников** in the main session panel or runs **Pair Notebook: Права участников** from the command palette. A server-project owner uses the same action in **Manage Server Project**. Select a participant, then configure:

- **All files / Selected files and folders / Read only.** `src/main.py` grants one file; `src/` grants the folder and descendants, including new files. Rename requires access to both paths. Moving or deleting a folder requires access to every affected file.
- **Python execution and compute control.** The host/server enforces this permission for direct requests and previously queued work. Revocation does not automatically stop an already running computation; use the existing confirmed stop action.
- **Line comments.** Members may create and close their own comments. The host/owner can also close another author's comment.
- **Shared P2P terminal: No access / View only / View and input.** Guests default to view only. Checks apply before history/output delivery, command acceptance and workspace preparation. The host confirms Ctrl+C. The server service has no shared operating-system shell; its code controls apply to notebook execution.

Changes apply after the dialogs complete. Cancelling any step preserves prior permissions. The host/owner retains full access; a server-administration credential alone does not grant project-owner permissions. The owner can change an individual member's permissions after a read-only invitation; invitation expiration and revocation still apply.

Permissions survive reconnects, server restarts and P2P host transfer. New participants retain the existing defaults: shared-file editing, Python and comments enabled; P2P terminal view only.

File restrictions govern the collaborative editor and synchronization API. Python and shell commands can change files through the operating system. Disable code execution and terminal input when a member should access only selected files. Switching from full access to restricted editing does not select Python by default. These are session capabilities, not a filesystem sandbox for arbitrary executable code.

## Add and close comments

1. Open a regular file or Jupyter cell in the connected project.
2. Select one or more lines; without a selection the current line is used.
3. Right-click, select **Pair Notebook: Комментарий к строкам**, and enter the text.
4. Lines receive a highlight and an author/preview badge on the first line. Hover to read the full comment.
5. Right-click, select **Pair Notebook: Закрыть комментарий**, and choose the comment.

Colors match the author's cursor. A stable participant color is selected by default; `pairNotebook.cursorColor` accepts a custom `#RRGGBB` value. Yjs anchors move comments with inserted lines. A deleted cell or replaced replica does not attach a comment to an unrelated cell/file.

The server retains comments across disconnects and restarts. Private-file comments are owner-only; visibility changes update participant projections. Session limits are 256 open comments and 4000 characters per comment. P2P comments live in session metadata rather than being inserted into source code.

## Verification

Automated tests cover HTTP/P2P permission boundaries, denied self-escalation, subtree rename/deletion, CRDT updates, persisted policy, terminal revocation before launch, comment privacy and anchors after line insertion. Editor-boundary tests exercise commands, selection ranges, color and badge offsets; native Extension Host E2E checks command registration. Theme/font appearance and physical input remain separate acceptance layers.
