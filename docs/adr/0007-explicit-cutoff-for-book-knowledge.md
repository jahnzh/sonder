# An explicit knowledge cutoff for book knowledge

Book chat, the character index/glossary and the relationship graph default to spoiler-free mode using a knowledge cutoff explicitly chosen by the user, rather than automatically granting access through the furthest position ever reached. Suggest the narrated sentence while following audio, otherwise the reading position; show the cutoff and require a manual choice when no reliable position is available, so rewinding or uncertain alignment does not silently reveal later material.

Moving the cutoff backward restricts available knowledge again, and complete-mode conversation context must not enter spoiler-free answers. This sacrifices automatic reuse of unrestricted context in favor of a consistent user-controlled spoiler limit; filtering supplied context cannot guarantee that a pretrained model never reveals outside knowledge.

The cutoff stays fixed while Book knowledge is open; an explicit "Update to my position" action adopts a new position. Questions beyond the cutoff explain the limit without revealing the answer or advancing it, so continuing background playback does not silently expand the available knowledge.
