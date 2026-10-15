# VPS sessions and administration

Pair Notebook 0.6.4 uses the same live-session dashboard for peer and VPS projects. A VPS is the session host; the authenticated owner remains a separate participant. Host capacity is sampled from the server, not from the editor. Missing telemetry is shown as unavailable. Existing owner identities are reused only after the server verifies their saved membership credential; matching a display name never grants ownership.

The landing page offers Start Session, Join Session and Connect to Permanent VPS. The single **VPS** view offers persistent creation, temporary creation and VPS administration. Legacy background-job commands remain available from the Command Palette.

## Create and join

Install the matching server before using the new administrative creation flow. The client checks the server capability first so an older server cannot silently ignore the requested project folder, mode or resource limits. Existing persistent sessions and their credentials remain compatible.

Creation asks for a verified HTTPS endpoint, a server administrative credential, a name, a relative project root, resource allocation and an independent session password. Administrative credentials are stored in VS Code SecretStorage for that endpoint. Never put credentials in settings or source control.

Use a separate root such as `projects/research-a` for each session. Equal roots and ancestor/descendant roots are rejected on the server, including case variants. New roots live inside the private Pair store; they do not grant access to arbitrary host directories. Existing sessions retain their original physical storage layout. File names inside independent roots may be identical without sharing contents.

Persistent sessions survive owner/editor departure. Temporary sessions end when their owner explicitly leaves or misses the 60-second presence lease. Ended temporary projects are removed once accepted work has settled; they are also retired after server restart. Save any required files before ending a temporary session. A network interruption shorter than the lease permits recovery.

An owner can copy an expiring invitation from the common dashboard. Participants paste that link into the ordinary **Join Session** action. Password-based discovery remains available through the permanent VPS connection action. A password holder cannot claim the owner's identity by entering the owner's name.

## Administration and limits

**VPS administration** lists all sessions after server administrator authentication. It supports lifecycle, resource allocation, participant removal and blocked names. **Session administration** additionally offers Public/Private folder visibility, invitations, participant roles, compute selection and consent. Private folders remain owner-only.

Kicking revokes the current membership but permits a new join. Blocking revokes the membership and blocks the participant name, including normalized/case variants. This is not an account-wide identity system: someone who knows a shared password may choose a new identity. Rotate the password and issue individual revocable invitations when continuing password access is inappropriate.

Resource allocation currently bounds the total size of current project contents and the number of queued/running executions. Admission limits do not interrupt accepted executions. The content limit does not cap immutable historical blobs, backups or total filesystem use. CPU/RAM/kernel limits remain enforced by the isolated worker service or container; this release does not claim per-session hard CPU/RAM quotas. Check aggregate host and worker budgets before admitting more work.

Server capacity in the dashboard shows free/total RAM and free/total disk, plus the CPU model. Device availability does not establish that a notebook kernel is running; a missing kernel status is reported explicitly.
