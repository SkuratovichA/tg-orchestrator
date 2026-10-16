#!/usr/bin/env python
"""Export every message of one or more forum topics to JSONL through the owner's Telethon session.
usage: tg-export-topic.py <chat_id> <out_dir> <env_file> <thread_id>...
Read-only. Writes <out_dir>/<thread_id>.jsonl (one message per line, oldest first).
Run with the telegram-mcp venv python (it has telethon + python-dotenv), like tg-download-voice.py.
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession

chat_id, out_dir, env_file = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
threads = [int(t) for t in sys.argv[4:]]
load_dotenv(env_file)
out_dir.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    cl = TelegramClient(
        StringSession(os.environ["TELEGRAM_SESSION_STRING_PERSONAL"]),
        int(os.environ["TELEGRAM_API_ID"]),
        os.environ["TELEGRAM_API_HASH"],
    )
    await cl.start()
    peer = await cl.get_input_entity(chat_id)
    for tid in threads:
        rows = []
        async for m in cl.iter_messages(peer, reply_to=tid, reverse=True):
            sender = await m.get_sender() if m.sender_id else None
            rows.append({
                "id": m.id,
                "date": m.date.isoformat() if m.date else None,
                "from_id": m.sender_id,
                "from": getattr(sender, "username", None) or getattr(sender, "first_name", None),
                "text": m.message or "",
                "media": type(m.media).__name__ if m.media else None,
                "reply_to": m.reply_to.reply_to_msg_id if m.reply_to else None,
            })
        path = out_dir / f"{tid}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"{tid}: {len(rows)} messages -> {path}")
    await cl.disconnect()


asyncio.run(main())
