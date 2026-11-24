# Board card attachments

A card's brief can carry screenshots and files. Paste a screenshot (⌘V) or drop files into the
brief when you create a card, or any time you edit it. Pasted images appear as thumbnails above
the brief text; other files appear as chips below it, next to the **Attach files** button. Remove
any of them with its ✕.

Attachments upload as soon as you add them. When creating a card, **Create card** becomes
available once every upload has finished; a failed upload can be retried or removed. On an open
card, changes save immediately, with no separate save step.

Images can be up to 10 MB. On servers that support file uploads, other files can be up to the
limit the server advertises, capped at 50 MB. A card holds up to 20 attachments. The column card
shows a paperclip with the count.

Files attached to a card you have not created yet are kept with the rest of the draft — see
[Drafts on the New card dialog](./board-card-drafts.md).

Attachments belong to the card, not to a branch: they are stored with T3 Code's own data, so they
survive a worktree being cleaned up or a project being cloned again. Deleting a card deletes its
files.

## What the agent sees

Every thread working on the card can list its attachments, with the path of each file, through the
card context it already reads, and open any of them on demand. Files added after a thread started
show up the next time it looks. When the board starts a build or planning thread, the brief's
attachments are also sent with the agent's first message, the same way files you attach in a chat
are: images are shown to it, and PDFs and other files are passed the way its provider takes them.
A card that is mostly a screenshot ("fix this") is understood from the start. Anything past the
per-message limits, and every file for a card running on another worker, is read by path instead.
Review rounds and follow-up turns read the files by path rather than receiving them again.

## Files agents attach

Agents attach files too. When a planning agent writes a plan that cites a file in its scratchpad
or temp folder, such as an HTML mock-up or a capture, the board copies that file onto the card and
lists it under **Attached files** at the end of the plan. A cited folder is attached as one
`.tar.gz`. The builder reads them from the card, even when it runs on another worker or the
planner's scratchpad is gone. An agent can also attach files to its own card directly.

Only an agent's own files in the temp folders (`/tmp`, `/var/tmp` and the system temp folder) are
shared. A plan that cites anything else, such as a file in your home folder, is stored, but the
agent is told the builder won't get the file. Ask the agent to copy the file into its scratchpad
and cite the copy. Each shared item is limited to 20 MiB, a folder to 200 files, and the card's
20-attachment limit still applies.

When a card is split, the files stay on the parent card, and every child card's agents can read
them. Citing a file again after it changed replaces the copy. Agents never remove attachments;
remove one yourself with its ✕.
