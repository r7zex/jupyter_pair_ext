# Pair Notebook 0.3.1 repair report

The 0.3.0 pass replaced the former machine-address transport with bundled Trystero. The 0.3.1 pass then audited the complete project again across identity, transport, lifecycle, CRDT consistency, filesystem boundaries, persistence, editor integration, UI startup, compatibility, testing, security, and packaging.

## Defects corrected during the pass

1. The previous transport required external machine networking and exposed address/port state in descriptors and invites.
2. Joining participants were treated as storage owners and could be asked for a folder.
3. Host changes could reuse a path that only existed on the previous computer.
4. Non-winning peers could update their election clock without entering the host-folder pause.
5. Stopping a transport with queued frames could recursively restart draining until stack exhaustion.
6. Older VS Code Node runtimes could lack the global WebSocket implementation used by Nostr discovery.
7. A fast webview could post its ready message before the extension registered the receiver, and an early state message could be lost.
8. The panel had no useful static content if its script failed.
9. Background persistence could repeatedly call VS Code save APIs and trigger format/save hooks.
10. Failed leave or end operations could erase the local restore marker even though the runtime remained active.
11. Legacy build output and artifact scripts could package stale version-specific files.
12. Direct and development dependencies contained avoidable audit findings.
13. Malformed binary-transfer dimensions could create an oversized sparse file before hash verification.
14. A failed Trystero send queue could be logged while a bulk synchronization caller still observed success.
15. Unsafe persisted or remote revision values could poison later filesystem conflict resolution.
16. Two VS Code windows on one computer could collide in the same session working folder.
17. A nested symbolic link could redirect persistence outside the selected project folder, and binary/termination replacement was not atomic on every fallback path.
18. Old VSIX files in the source directory were not explicitly excluded from a newly built VSIX.
19. A bearer-token holder could claim the application identity of a known participant who was offline.
20. Client clocks supplied the original join order, so clock skew could change deterministic failover priority.
21. Bootstrap streamed the physical host working file even when an open editor contained newer authoritative CRDT text.
22. Invalid UTF-8 text and malformed notebooks could be decoded with replacement characters instead of remaining lossless binary files.
23. Portable case and Unicode normalization collisions could create incompatible project trees on another operating system.
24. Rapid remote text updates could race through concurrent `workspace.applyEdit` calls and leave the editor on an older revision.
25. An oversized merged notebook cell was silently truncated while the underlying CRDT retained different contents.
26. A pre-created symlink at the deterministic autosave session path could redirect rotation outside the selected autosave root.
27. Hardware and Python environment discovery ran more often than needed, including repeated failed NVIDIA probes.
28. A temporary SecretStorage read failure could leave the panel looking unusable instead of keeping Start/Join available with an actionable error.
29. Bidirectional/invisible path controls and ambiguous remote execution file/directory manifests were not rejected consistently.

Each correction has a deterministic regression or packaging check. The current suite contains 164 passing tests. The public relay smoke is intentionally separate because it depends on current internet and relay availability.

## Remaining environmental boundaries

- WebRTC connectivity depends on the networks between participants. Trystero supplies multiple STUN servers; restrictive symmetric NAT or firewall policies can still require TURN.
- Public Nostr relays are external availability dependencies used only for discovery.
- Notebook execution requires a suitable local Python/Jupyter environment on the selected executor.
- Participants are trusted collaborators because remote execution is an intentional feature.

No remaining project defect was found in the final manual audit described by `BUILD-REPORT.md`. The managed Codex Security Deep Scan worker could not run because this desktop session did not provide its required managed filesystem permission profile; this environmental limitation is recorded rather than represented as a successful scan.
