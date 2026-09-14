#!/usr/bin/env python
"""Download the voice/audio of a Telegram message through the owner's Telethon session.

usage: tg-download-voice.py <chat_id> <message_id> <out_path> <env_file>
Run with the telegram-mcp venv python (it has telethon + python-dotenv).
Shared by transcribe-fallback.sh and transcribe-chunked.sh — keep it the single copy.
"""
import asyncio
import os
import sys

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession

chat_id, msg_id, out, env_file = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
load_dotenv(env_file)


async def main() -> None:
    cl = TelegramClient(
        StringSession(os.environ["TELEGRAM_SESSION_STRING_PERSONAL"]),
        int(os.environ["TELEGRAM_API_ID"]),
        os.environ["TELEGRAM_API_HASH"],
    )
    await cl.start()
    # get_input_entity, not get_entity — otherwise Telethon raises a bogus
    # PeerIdInvalidError because the peer never gets resolved.
    peer = await cl.get_input_entity(chat_id)
    msg = (await cl.get_messages(peer, ids=[msg_id]))[0]
    if msg is None:
        raise SystemExit(f"message {msg_id} not found in {chat_id}")
    if not msg.voice and not msg.video_note and not msg.audio:
        raise SystemExit(f"message {msg_id} carries no voice/audio")
    await cl.download_media(msg, file=out)
    await cl.disconnect()


asyncio.run(main())
