"""Count only local message content with the pinned public tokenizer; no network."""
import json
import sys

import tokenizers

if tokenizers.__version__ != "0.22.1":
    raise RuntimeError("pinned tokenizer runtime version required")
tokenizer = tokenizers.Tokenizer.from_file(sys.argv[1])
messages = json.load(sys.stdin)
if not isinstance(messages, list) or any(not isinstance(message, str) for message in messages):
    raise RuntimeError("plain message content list required")
counts = [len(tokenizer.encode(message, add_special_tokens=False).ids) for message in messages]
print(json.dumps({"version": tokenizers.__version__, "messageTokens": counts}))
