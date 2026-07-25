# tui-code Replication Scope

This project aligns selected `tui-code` architecture concepts without copying every capability.

Required modules and concepts in scope:

- ExecutionCoordinator
- TurnEngine
- Tool
- PermissionMode
- Plan Mode
- Session Storage
- MCP
- Tasks
- SDK/headless
- TUI logging excluded
- Remote excluded

Explicit exclusions:

Do not replicate the TUI logging system.
Do not enable outbound telemetry by default.
Do not implement remote capabilities.
Do not create remote transport.
Do not implement remote resume.

Workflow separation:

Workflow node `mode: "plan"` is removed from the supported model.
workflow nodes must reject both `mode: "plan"` and `permission_mode: "plan"` configuration.
