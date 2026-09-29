// Every Agent bridge operation that only reads or shows, never raising a card.
// They take the bridge's read lane, which is answered beside a write that is
// waiting on its card; everything else is the task's one write in flight
// (agent-bridge.js).
//
// Only the two knowledge reads used to be here. On 2026-09-23 a work task
// asked for a video's status while its own stop-card was up and was told
// "这个任务已有一个飞书操作在等待确认" -- a read refused behind a write it had
// nothing to do with, with the person's decision still pending.
import { KNOWLEDGE_READS } from "./agent-knowledge-actions.js";
import { MEDIA_READS } from "./agent-media-actions.js";
import { DELIVERY_READS } from "./agent-delivery-actions.js";
import { SCHEDULE_READS } from "./agent-schedule-actions.js";

export const AGENT_READS = Object.freeze([...KNOWLEDGE_READS, ...MEDIA_READS, ...DELIVERY_READS, ...SCHEDULE_READS]);
