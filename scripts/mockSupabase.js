/**
 * Saka Fleet — In-memory Supabase mock for offline suites (v1.15.0).
 * -----------------------------------------------------------------
 * Supports the exact query chains used by subscriptions.js / trialEngine.js:
 *   select().eq().in().is().gte().lte().order().limit().maybeSingle()/single()
 *   insert(), update().eq().in(), upsert()
 * and honours the `paystack_webhook_events.event_id` unique constraint so the
 * webhook idempotency path is testable without a database.
 *
 * Not a general PostgREST implementation — deliberately small and predictable.
 */

export function createMockSupabase(seed = {}, options = {}) {
  const db = {};
  for (const [table, rows] of Object.entries(seed)) {
    db[table] = rows.map((row) => ({ ...row }));
  }
  const state = { inserts: [], updates: [], deletes: [], calls: 0 };

  const tableRows = (table) => {
    if (!db[table]) db[table] = [];
    return db[table];
  };

  const matches = (row, filters) => filters.every(([op, col, value]) => matchOne(row, op, col, value));

  /**
   * v1.75.1 (Phase 14B) — one condition evaluator, shared by AND filters and
   * PostgREST-style `.or()` groups. `ilike` is a case-insensitive wildcard match
   * (`%` = any run of characters), which is what the records keyword search
   * sends (`label.ilike.%karen%`).
   */
  function matchOne(row, op, col, value) {
    const current = row[col];
    if (op === 'eq') return current === value;
    if (op === 'neq') return current !== value;
    if (op === 'in') return Array.isArray(value) && value.includes(current);
    if (op === 'is') return value === null ? (current === null || current === undefined) : current === value;
    if (op === 'like') return String(current ?? '').startsWith(String(value ?? '').replace(/%/g, ''));
    if (op === 'ilike') return ilikeMatch(current, value);
    if (op === 'gte') return new Date(current).getTime() >= new Date(value).getTime();
    if (op === 'lte') return new Date(current).getTime() <= new Date(value).getTime();
    if (op === 'lt') return new Date(current).getTime() < new Date(value).getTime();
    if (op === 'gt') return new Date(current).getTime() > new Date(value).getTime();
    return true;
  }

  function ilikeMatch(current, pattern) {
    const text = String(current ?? '');
    const source = String(pattern ?? '');
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(source.replace(/%/g, '').toLowerCase());
    }
  }

  /** `col.op.value` → [op, col, value]; null when the fragment is not a condition. */
  function parseOrCondition(fragment) {
    const match = String(fragment || '').trim().match(/^([A-Za-z0-9_]+)\.([a-z]+)\.(.*)$/);
    if (!match) return null;
    return [match[2], match[1], match[3]];
  }

  function from(table) {
    const query = {
      action: 'select',
      filters: [],
      orGroups: [],
      rangeSpec: null,
      orderBy: null,
      max: null,
      head: false,
      counting: false,
      payload: null
    };

    const api = {
      select(_columns, options = {}) {
        if (options.count) query.counting = true;
        if (options.head) query.head = true;
        return api;
      },
      insert(rows) {
        query.action = 'insert';
        query.payload = Array.isArray(rows) ? rows : [rows];
        return api;
      },
      upsert(rows) {
        query.action = 'upsert';
        query.payload = Array.isArray(rows) ? rows : [rows];
        return api;
      },
      update(patch) {
        query.action = 'update';
        query.payload = patch;
        return api;
      },
      // v1.63.1 (2C) — delete support so context-cache invalidation is spyable.
      delete(options = {}) {
        query.action = 'delete';
        query.counting = Boolean(options.count);
        return api;
      },
      eq(column, value) { query.filters.push(['eq', column, value]); return api; },
      neq(column, value) { query.filters.push(['neq', column, value]); return api; },
      in(column, value) { query.filters.push(['in', column, value]); return api; },
      is(column, value) { query.filters.push(['is', column, value]); return api; },
      like(column, pattern) { query.filters.push(['like', column, pattern]); return api; },
      gte(column, value) { query.filters.push(['gte', column, value]); return api; },
      lte(column, value) { query.filters.push(['lte', column, value]); return api; },
      lt(column, value) { query.filters.push(['lt', column, value]); return api; },
      gt(column, value) { query.filters.push(['gt', column, value]); return api; },
      // v1.75.1 (Phase 14B) — records surface needs the same three operators the
      // live PostgREST calls use: case-insensitive search, OR groups and offset
      // pagination. Purely additive; every existing suite keeps its behaviour.
      ilike(column, pattern) { query.filters.push(['ilike', column, pattern]); return api; },
      or(expr) {
        // PostgREST semantics: the comma list is a DISJUNCTION (a OR b), so each
        // condition becomes its own group; two `.or()` calls are ANDed together.
        const conditions = String(expr || '')
          .split(',')
          .map(parseOrCondition)
          .filter(Boolean);
        for (const condition of conditions) query.orGroups.push([condition]);
        return api;
      },
      range(from, to) {
        const start = Math.max(0, Number(from) || 0);
        const end = Number.isFinite(Number(to)) ? Number(to) : start;
        query.rangeSpec = { from: start, to: end };
        return api;
      },
      order(column, options = {}) {
        query.orderBy = { column, ascending: options.ascending !== false };
        return api;
      },
      limit(count) { query.max = count; return api; },
      maybeSingle() { return run('maybeSingle'); },
      single() { return run('single'); },
      then(onFulfilled, onRejected) {
        return run('many').then(onFulfilled, onRejected);
      }
    };

    async function run(kind) {
      state.calls += 1;
      const rows = tableRows(table);

      if (query.action === 'insert' || query.action === 'upsert') {
        // v1.61.17 — optional constraint hook (e.g. simulate the live legacy
        // asset_type CHECK so the save path can be proven against it).
        if (query.action === 'insert' && typeof options.beforeInsert === 'function') {
          const rejection = options.beforeInsert(table, query.payload);
          if (rejection && rejection.error) return { data: null, error: rejection.error };
        }
        const incoming = query.payload.map((row, index) => ({
          id: row.id || `mock-${table}-${rows.length + index + 1}`,
          created_at: row.created_at || new Date().toISOString(),
          ...row
        }));
        if (table === 'paystack_webhook_events') {
          const duplicate = incoming.find((row) => rows.some((existing) => existing.event_id && existing.event_id === row.event_id));
          if (duplicate) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "paystack_webhook_events_event_id_key"' } };
          }
        }
        rows.push(...incoming);
        state.inserts.push({ table, rows: incoming });
        if (kind === 'maybeSingle' || kind === 'single') return { data: incoming[0] || null, error: null };
        return { data: incoming, error: null, count: incoming.length };
      }

      let selected = rows.filter((row) => matches(row, query.filters));
      if (query.orGroups.length) {
        selected = selected.filter((row) => query.orGroups.some(
          (group) => group.every(([op, col, value]) => matchOne(row, op, col, value))
        ));
      }

      if (query.action === 'update') {
        // v1.71.0 — optional rejection hook (e.g. simulate an un-migrated
        // column: beforeUpdate returns { error } and the update fails).
        if (typeof options.beforeUpdate === 'function') {
          const rejection = options.beforeUpdate(table, query.payload);
          if (rejection && rejection.error) return { data: null, error: rejection.error };
        }
        const patched = [];
        for (const row of selected) {
          Object.assign(row, query.payload);
          patched.push({ ...row });
        }
        state.updates.push({ table, patch: query.payload, rows: patched });
        if (kind === 'maybeSingle' || kind === 'single') return { data: patched[0] || null, error: null };
        return { data: patched, error: null, count: patched.length };
      }

      if (query.action === 'delete') {
        // v1.63.1 (2C) — deterministic delete + recorder (user_context_cache spy).
        const doomed = new Set(selected);
        const removed = selected.length;
        db[table] = rows.filter((row) => !doomed.has(row));
        const eqFilter = query.filters.find(([op]) => op === 'eq') || null;
        state.deletes.push({
          table,
          col: eqFilter ? eqFilter[1] : null,
          value: eqFilter ? eqFilter[2] : null,
          filters: query.filters.map(([op, col, value]) => ({ op, col, value })),
          removed
        });
        if (query.head || query.counting) return { data: null, error: null, count: removed };
        return { data: null, error: null, count: removed };
      }

      if (query.orderBy) {
        const { column, ascending } = query.orderBy;
        selected = [...selected].sort((a, b) => {
          const av = a[column];
          const bv = b[column];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (query.max) selected = selected.slice(0, query.max);
      if (query.rangeSpec) selected = selected.slice(query.rangeSpec.from, query.rangeSpec.to + 1);

      if (query.head || query.counting) {
        return { data: null, error: null, count: selected.length };
      }
      if (kind === 'maybeSingle') return { data: selected[0] || null, error: null };
      if (kind === 'single') return { data: selected[0] || null, error: null };
      return { data: selected, error: null, count: selected.length };
    }

    return api;
  }

  // v1.77.0 (Phase 16) — Storage surface for the inline report PDF lane.
  // Uploads never touch the network; the URL is deterministic so tests can pin
  // it. `state.uploads` records every object for assertions.
  const storageState = state.uploads = state.uploads || [];
  const storage = {
    from(bucket) {
      return {
        upload: async (path) => {
          storageState.push({ bucket, path });
          return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://mock.storage/${bucket}/${path}` } }),
        createSignedUrl: async (path) => ({ data: { signedUrl: `https://mock.storage/${bucket}/${path}?signed=1` } })
      };
    },
    createBucket: async () => ({ data: {}, error: null })
  };

  return { client: { from, storage }, db, state };
}

export default { createMockSupabase };
