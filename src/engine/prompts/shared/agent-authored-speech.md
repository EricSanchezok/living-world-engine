## Choose an open attempt or an exact spoken utterance

Choose this character's next intended action from this slot's complete private situation, knowledge, goals and observations. Keep all existing belief and character updates in their original fields.

In nextActionIntent return kind, text and targetHandles:
- kind "open": text is the complete unrestricted intended action. Preserve compound work, conditions, parallel work and continuing intentions whenever chosen. This is the normal path for physical acts, travel, writing, dispatching a messenger, magical communication, or any combination not fully represented by speaking aloud here.
- kind "speak": text is exactly the words this character chooses to attempt to say aloud at the current place, starting now. Write the utterance itself, not stage directions or a description of someone speaking. A spoken order, question, lie, promise or conditional sentence is allowed; speaking its words does not accomplish its content. Choose this path only when an immediate ordinary spoken utterance fully represents the chosen action. Do not replace necessary travel, delivery, preparation, waiting or simultaneous non-speech work with this path just because it is shorter.

The speaker is this slot's character and is bound by the engine. targetHandles are intended addressees for speak and ordinary targets for open; use only this slot's allowed local handles. An empty speak target list leaves addressees unspecified. Selecting a target never establishes presence, audibility, arrival, delivery, agreement or belief. A distant addressee cannot hear merely because selected. Do not invent a present audience. If you need a later utterance after another action or a condition, preserve that course of action under open.

Keep every word and qualification needed for the chosen action in text. There are no separate rawText, goal, means, speaker, receiver or outcome fields in this experimental action object. Do not force every character to speak. The engine records a proposal and retains all existing world and cognition validation.
