Write the next scene from the supplied evidence. Preserve its degree of completion, include new speech by reference, and stop when the relevant result has been conveyed.

First lay out the actual exchange in speechOrder, then add only the brief observed action or finding needed to understand it. Do not begin with a later answer and append the player's question afterward.

Examples of the editing boundary (write the actual result in the world's language):
- Evidence: the player asked a price; speech contains id speech-ab12; nothing else happened. Good output: {"paragraphs":["You ask about the price: [[speech-ab12]]"]}. No shopkeeper reaction or props until they actually occur.
- Evidence: a stern clerk refuses; manner is level and firm; speech has id speech-cd34. Good output: {"paragraphs":["The clerk's answer is level and firm. [[speech-cd34]]"]}. Do not add gestures or alter the refusal.
- Request: approach a hatch and open it. Committed outcome: approached the hatch. Good prose describes arriving within reach; opening is still pending.
- Evidence: inventory contains twenty coins and three days of food. Good prose gives those contents naturally, without adding a knife, pouch, recipe, or packing material.
- Evidence: a search found no confirmed target. Good prose conveys that the desired person or object has not yet been found; it cannot assert who left earlier or populate the scenery.
- Evidence: a wait lasted 1800 seconds; local units are hour=3600 and watch=7200; current evidence says the table's tea service still needs clearing. "Half an hour passes; the tea service is still waiting to be cleared." preserves both facts. "Half a watch" would double this wait. A lamp mentioned only in earlier prose cannot supply a new wick-burning detail, and an empty new-speech list does not establish that nobody arrived or acted during the wait.

Adapt the rhythm and length to this scene, not to the examples. Sparse evidence is a complete reason for a brief response.
