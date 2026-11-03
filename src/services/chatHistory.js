/**
 * v1.32.3 — conversation history freshness.
 *
 * Live incident 2026-11-01: at 08:49 the bot answered "one step away" from a
 * 10-turn window that ended at 07:06 (1 h 43 m stale), because the last-10 read
 * had no age limit. History older than this window is never injected into the
 * model prompt; the database rows are kept, only the prompt is protected.
 */
export const CHAT_HISTORY_MAX_AGE_MINUTES = (() => {
  const raw = Number(process.env.CHAT_HISTORY_MAX_AGE_MINUTES || 45);
  if (!Number.isFinite(raw) || raw <= 0) return 45;
  return Math.min(raw, 24 * 60);
})();

// v1.56.4 - Saka carries the whole conversation, not just submitted fields.
// 20-40 recent turns ride the prompt (default 40), clamped to a safe bound.
export const CHAT_HISTORY_MAX_MESSAGES = (() => {
  const raw = Number(process.env.CHAT_HISTORY_MAX_MESSAGES || 40);
  if (!Number.isFinite(raw) || raw <= 0) return 40;
  return Math.min(Math.max(raw, 20), 60);
})();

export async function saveChatMessage(supabase, userPhone, role, message) {
  if (!supabase || !userPhone || !message) return null;

  try {
    const cleanPhone = userPhone.replace(/[^\d+]/g, '');
    const { data, error } = await supabase.from('chat_history').insert([{
      user_phone: cleanPhone,
      role: role === 'model' ? 'assistant' : role,
      message: message.trim(),
      created_at: new Date().toISOString()
    }]).select();

    if (error) {
      console.warn('[chatHistory] Error inserting chat message:', error.message);
      return null;
    }
    return data?.[0] || null;
  } catch (err) {
    console.warn('[chatHistory] Exception in saveChatMessage:', err.message);
    return null;
  }
}

export async function getRecentChatHistory(supabase, userPhone, limit = CHAT_HISTORY_MAX_MESSAGES, { maxAgeMinutes = CHAT_HISTORY_MAX_AGE_MINUTES } = {}) {
  if (!supabase || !userPhone) return [];

  try {
    const cleanPhone = userPhone.replace(/[^\d+]/g, '');
    const windowMinutes = Number(maxAgeMinutes);
    const cutoffMs = Number.isFinite(windowMinutes) && windowMinutes > 0
      ? Date.now() - windowMinutes * 60 * 1000
      : null;
    let query = supabase
      .from('chat_history')
      .select('role, message, created_at')
      .eq('user_phone', cleanPhone);
    if (cutoffMs) query = query.gte('created_at', new Date(cutoffMs).toISOString());
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data || data.length === 0) {
      return [];
    }

    // Chronological order (oldest to newest among the last N), re-checked
    // locally so a timezone-skewed row can never resurrect stale context.
    const fresh = cutoffMs
      ? data.filter((row) => {
        const at = row?.created_at ? Date.parse(row.created_at) : NaN;
        return !Number.isFinite(at) || at >= cutoffMs;
      })
      : data;
    if (!fresh.length) return [];
    const chronological = [...fresh].reverse();

    // Map into Saka's provider-neutral turn format: { role: 'user' | 'model', parts: [{ text }] }
    // (normalizeHistory() in aiClient.js converts this into DeepSeek/OpenAI messages.)
    const turns = [];
    for (const item of chronological) {
      const turnRole = (item.role === 'assistant' || item.role === 'model') ? 'model' : 'user';
      const text = (item.message || '').trim();
      if (!text) continue;

      // Merge adjacent turns with identical role to keep the conversation alternating
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.role === turnRole) {
        lastTurn.parts[0].text += `\n${text}`;
      } else {
        turns.push({
          role: turnRole,
          parts: [{ text }]
        });
      }
    }

    return turns;
  } catch (err) {
    console.warn('[chatHistory] Exception in getRecentChatHistory:', err.message);
    return [];
  }
}
