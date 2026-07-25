# Repository workflow

For every coding task:

1. Start from the latest `origin/main`.
2. Never commit or push directly to `main`.
3. Create a new branch before modifying files.
4. Use branch names in this format:
   - `codex/feat-<short-name>`
   - `codex/fix-<short-name>`
   - `codex/chore-<short-name>`
5. Run relevant tests or builds before committing.
6. Commit the completed changes.
7. Push the new branch to origin.
8. Open a pull request targeting `main`.

If GitHub returns HTTP 403:
- Do not delete the environment immediately.
- Do not repeatedly retry the same push.
- Report the complete Git error.
- Show the current branch, remote URL, and repository permission status.
