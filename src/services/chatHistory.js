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

export async function getRecentChatHistory(supabase, userPhone, limit = 10) {
  if (!supabase || !userPhone) return [];

  try {
    const cleanPhone = userPhone.replace(/[^\d+]/g, '');
    const { data, error } = await supabase
      .from('chat_history')
      .select('role, message, created_at')
      .eq('user_phone', cleanPhone)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data || data.length === 0) {
      return [];
    }

    // Chronological order (oldest to newest among the last N)
    const chronological = [...data].reverse();

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
