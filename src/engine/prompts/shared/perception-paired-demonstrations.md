# Synthetic paired perception demonstrations

These authored miniature cases are task instructions, not records from the active world. Each pair supplies its own synthetic state and local reference domain. Resolve the real request from its complete actual context; do not copy any example identity, fact, check or target index into the real answer. Unmentioned mechanics in a miniature case are absent only in that case. The cases illustrate complete output objects in the unchanged directive schema. They do not define a universal action vocabulary or decide the active assignment.

## delivery-pending

Input: Now: speaker and assistant share a quiet office; inspector is in a distant tower. Only ordinary hearing exists. Target 0 is assistant noticing speaker's action; target 1 is inspector noticing that same action. Action: 'Tell my assistant aloud to carry the sealed note to the inspector. After it arrives, ask the inspector to read it.' No travel or delivery has occurred.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"perceived","reason":"The assistant hears the instruction now; the note's hidden contents are not spoken.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:assistant"}],"checkRefs":[],"stimulus":{"summary":"You hear a request to carry a sealed note to the inspector.","introductions":[],"apparentClaims":[],"sourceEventRefs":[]}},{"targetIndex":1,"kind":"no_stimulus","reason":"The inspector is remote. Delivery and the later request to read are pending.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:inspector"}],"checkRefs":[]}]}
```

## live-channel

Input: Same people, locations, action and targets as delivery-pending. One difference: authored ref:law:office-relay establishes an already active sound relay carrying the office's audible speech to the inspector now. It does not transmit sealed note contents.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"perceived","reason":"The assistant hears the instruction now.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:assistant"}],"checkRefs":[],"stimulus":{"summary":"You hear a request to carry a sealed note to the inspector.","introductions":[],"apparentClaims":[],"sourceEventRefs":[]}},{"targetIndex":1,"kind":"perceived","reason":"The active authored relay carries the instruction now; the note has not arrived.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:inspector"},{"kind":"law","ref":"ref:law:office-relay"}],"checkRefs":[],"stimulus":{"summary":"Through the office relay, you hear a request to carry a sealed note to you.","introductions":[],"apparentClaims":[],"sourceEventRefs":[]}}]}
```

## ordered-question

Input: Speaker and listener are in a quiet room. Target 0: listener noticing speaker's action. Speaker has not begun checking the private stock list. Action: 'Silently check the stock list; only after finishing, ask the listener aloud which delivery they want.' Listener cannot see the private list or any other distinct starting cue. No special channels or required checks apply.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"no_stimulus","reason":"The question is ordered after unfinished private work; no current cue reaches the listener.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:listener"}],"checkRefs":[]}]}
```

## parallel-question

Input: Same state and target as ordered-question. Action instead: 'Silently check the stock list while asking the listener aloud which delivery they want.' No prerequisite blocks the independent speech.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"perceived","reason":"The audible question is simultaneous with private checking, not dependent on its completion.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:listener"}],"checkRefs":[],"stimulus":{"summary":"You hear: 'Which delivery do you want?'","introductions":[],"apparentClaims":[],"sourceEventRefs":[]}}]}
```

## silent-condition

Input: Speaker and listener share a quiet room. Target 0: listener noticing speaker's action. Action: 'Privately consider: if the bridge closes tomorrow, I could offer passage by boat.' Nothing is spoken or visibly signaled; the future bridge condition is unestablished. No special channels apply.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"no_stimulus","reason":"An unspoken conditional thought supplies no present sensory cue.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:listener"}],"checkRefs":[]}]}
```

## spoken-condition

Input: Same state and target as silent-condition. Action instead: 'Say to the listener now: If the bridge closes tomorrow, I can offer passage by boat.' The condition is inside the audible quotation, not a prerequisite to speaking.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"perceived","reason":"The listener hears the conditional offer now. Hearing it does not establish a closed bridge or successful future passage.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:listener"}],"checkRefs":[],"stimulus":{"summary":"You hear: 'If the bridge closes tomorrow, I can offer passage by boat.'","introductions":[],"apparentClaims":[],"sourceEventRefs":[]}}]}
```

## supported-uncertainty

Input: Speaker and listener face each other across a table. Target 0: listener noticing ref:action:conceal, speaker's attempt to slip a token into a sleeve. Ref:law:concealment requires a challenging environment check for noticing this concealed onset. No observer aptitude applies. No check is committed yet. Success of hiding the token is a separate outcome.

Output:
```json
{"kind":"request_checks","requests":[{"proposalKey":"notice-sleeve","actorRef":"ref:entity:listener","targetRef":"ref:entity:speaker","ratingRef":null,"difficulty":{"kind":"environment","band":"challenging","source":{"kind":"law","ref":"ref:law:concealment"}},"mode":"normal","stakes":"Whether the listener notices the concealed hand movement at onset.","visibility":"full","causes":[{"kind":"action","ref":"ref:action:conceal"},{"kind":"law","ref":"ref:law:concealment"}]}]}
```

## fixed-failure

Input: Same source, target and law as supported-uncertainty. Its exact perception check is already committed as ref:check:notice-sleeve and failed. No distinct new cue or alternative route exists.

Output:
```json
{"kind":"done","reports":[{"targetIndex":0,"kind":"no_stimulus","reason":"The required check for this onset failed; it cannot be rerolled or dropped.","evidence":[{"kind":"entity","ref":"ref:entity:speaker"},{"kind":"entity","ref":"ref:entity:listener"},{"kind":"law","ref":"ref:law:concealment"}],"checkRefs":["ref:check:notice-sleeve"]}]}
```

Return only the real request's directive. Keep each actual observer, source actor, direct addressee and prospective recipient distinct. Use actual observer-local bindings for any apparent claims; an example's empty claim list is not a reason to omit claims needed in the real stimulus.
