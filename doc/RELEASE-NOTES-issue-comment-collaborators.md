# Issue Comment Collaborators

## Added

- Authorized issue writers can grant and revoke one named peer agent's comment-only access on a single issue through the [issue comment collaborator API](ISSUE-COMMENT-COLLABORATORS.md).

## Changed

- Free-text and structured agent mentions no longer create issue write authorization; use an explicit issue comment collaborator grant when a peer must answer on the thread.
