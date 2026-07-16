# Omega.dev Glossary

### Artifact
An immutable or append-only output referenced by an event, such as a patch, handoff, process stream, evaluation report, or materialized harness export.

### Candidate harness
An immutable harness version proposed by an evolution session but not yet selected as a project's default.

### Capability envelope
The immutable tool, filesystem, credential-name, model-role, and budget limits assigned to a child session when it is spawned.

### Component
A content-addressed unit referenced by a harness manifest, such as a runner, tool, connector, skill, workflow, policy prompt, or context compiler.

### Crystallization
The process of extracting a transferable method from a costly successful trajectory and turning it into a candidate knowledge or harness artifact.

### Harness
The versioned composition that controls agent behavior: runner, tools, skills, workflows, context strategy, role bindings, and related mutable components.

### Handoff
An immutable summary artifact produced by one session and used to start a new linked session without replaying the entire prior transcript.

### Incumbent
The harness version currently authorized to evaluate and potentially replace itself with a child candidate.

### Kernel
The small, non-evolving daemon substrate responsible for storage, APIs, model transport, process supervision, activation, rollback, and enforcement of effective capabilities.

### Local marketplace
The local catalog of harnesses and reusable components created and vetted by this Omega installation. It is not an external package feed.

### Process handle
A daemon-issued identifier used to observe, write to, or cancel a live tool process.

### Project
A logical repository identity that owns a harness lineage, knowledge, evaluations, sessions, and registered workspaces.

### Promotion Eval
The paired incumbent-versus-candidate evaluation and decision protocol. It is the evidence gate for selecting a new project default harness.

### Runner
A mutable harness component executed as a separate process. It determines the model/tool loop, context construction, subagent behavior, and evolution requests.

### Session
One append-only execution history. An intentional resume starts a new session connected to its predecessor by a thread and handoff.

### Thread
A lineage of sessions that collectively pursue the same continuing objective.

### Workspace
A registered checkout or worktree through which a logical project is accessed.
