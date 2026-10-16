import { createHash, randomUUID } from 'node:crypto';

const uuidBuffer = () => Buffer.from(randomUUID().replaceAll('-', ''), 'hex');

export class MySqlRepository {
  constructor(pool, { historyPool = pool, historyCursorTtlMs = 120000, maxHistoryCursors = 32 } = {}) {
    this.pool = pool;
    this.historyPool = historyPool;
    this.historyCursorTtlMs = historyCursorTtlMs;
    this.maxHistoryCursors = maxHistoryCursors;
    this.historyCursors = new Map();
    this.historyCursorCleanup = setInterval(() => { void this.#expireHistoryCursors(); }, 10000);
    this.historyCursorCleanup.unref?.();
  }

  async persist(normalized) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const { record, samples, projection } = normalized;
      const [insert] = await connection.execute(
        `INSERT IGNORE INTO mqtt_inbox
         (inbox_id,cps_id,topic,schema_version,source_timestamp,published_at,received_at,dedupe_key,payload_hash,raw_payload,payload_json,qos,retain_flag,processing_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'stored')`,
        [uuidBuffer(), record.cpsId, record.topic, record.schemaVersion, record.sourceTimestamp, record.publishedAt, record.receivedAt,
          Buffer.from(record.dedupeKey, 'hex'), Buffer.from(record.payloadHash, 'hex'), record.rawPayloadText, JSON.stringify(record.payload), record.qos, record.retain],
      );
      if (insert.affectedRows === 0) {
        await connection.commit();
        return { duplicate: true };
      }
      const [rows] = await connection.execute(
        'SELECT inbox_id FROM mqtt_inbox WHERE cps_id=? AND topic=? AND dedupe_key=?',
        [record.cpsId, record.topic, Buffer.from(record.dedupeKey, 'hex')],
      );
      const inboxId = rows[0].inbox_id;

      for (const sample of samples) {
        await connection.execute(
          `INSERT IGNORE INTO telemetry_samples
           (sample_id,inbox_id,signal_key,sample_key,node_id,tag,value_num,value_bool,value_text,raw_value_json,unit,source_timestamp,server_timestamp,sample_timestamp,received_at,quality,evidence_status,is_valid,is_stale,is_fresh,evidence_age_ms,sample_ordinal)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuidBuffer(), inboxId, sample.signalKey, Buffer.from(sample.sampleKey, 'hex'), sample.nodeId, sample.tag, sample.valueNum, sample.valueBool,
          sample.valueText, JSON.stringify(sample.rawValue), sample.unit, sample.sourceTimestamp, sample.serverTimestamp,
            sample.sampleTimestamp, sample.receivedAt, sample.quality, sample.evidenceStatus, sample.isValid, sample.isStale,
            sample.isFresh, sample.evidenceAgeMs, sample.ordinal],
        );
      }

      if (projection?.kind === 'status') await this.#persistStatus(connection, inboxId, projection, record);
      if (projection?.kind === 'oee') await this.#persistOee(connection, inboxId, projection, record);
      if (projection?.kind === 'health') await this.#persistHealth(connection, inboxId, projection, record);
      const ppuDuplicate = projection?.kind === 'ppu'
        ? await this.#persistPpu(connection, projection, record)
        : false;
      if (samples.length) await this.#persistExitEdges(connection, inboxId, samples, record);
      await connection.commit();
      return { duplicate: false, ppuDuplicate };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async #persistStatus(connection, inboxId, p, record) {
    const [latest] = await connection.execute(
      'SELECT operational_state, started_at FROM operational_state_events WHERE cps_id=? ORDER BY started_at DESC LIMIT 1 FOR UPDATE',
      [record.cpsId],
    );
    const previous = latest[0]?.operational_state ?? null;
    if (latest[0]?.started_at && record.publishedAt && record.publishedAt <= latest[0].started_at) return;
    if (previous === p.state) return;
    const stateEventId = uuidBuffer();
    await connection.execute(
      `INSERT INTO operational_state_events
       (state_event_id,cps_id,inbox_id,lifecycle_phase,operation_mode,previous_state,operational_state,reason,evidence_source,evidence_status,started_at,recorded_at,mode_evidence_json,evidence_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [stateEventId, record.cpsId, inboxId, record.payload.lifecyclePhase ?? null, record.payload.operationMode ?? null, previous, p.state ?? 'UNKNOWN', p.reason,
        record.payload.operationalStateEvidence?.evidenceSource ?? null, p.evidenceStatus,
        record.publishedAt, record.receivedAt, JSON.stringify(record.payload.operationModeEvidence ?? {}), JSON.stringify(record.payload.operationalStateEvidence ?? {})],
    );
    await connection.execute(
      `UPDATE operational_state_events SET ended_at=? WHERE cps_id=? AND state_event_id<>? AND ended_at IS NULL`,
      [record.publishedAt, record.cpsId, stateEventId],
    );
  }

  async #persistOee(connection, inboxId, p, record) {
    const raw = record.payload;
    await connection.execute(
      `INSERT INTO oee_snapshots
       (oee_id,cps_id,inbox_id,calculation_state,evidence_status,calculation_version,calculated_at,window_start,window_end,oee_value,availability,performance,quality_value,
        total_count,completed_cycles,incomplete_cycles,last_cycle_time_ms,average_cycle_time_ms,sample_counts_json,rising_edges_json,
        planned_time_ms,run_time_ms,stopped_time_ms,maintenance_time_ms,unknown_time_ms,reference_cycle_time_ms,
        quality_product_validated,quality_evidence_status,payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidBuffer(), record.cpsId, inboxId, p.calculationState, p.evidenceStatus, p.calculationVersion, p.calculatedAt, p.windowStart, p.windowEnd, p.oee,
        p.availability, p.performance, p.quality, raw.production?.totalCount ?? null, raw.production?.completedCycles ?? null,
        raw.production?.incompleteCycles ?? null, raw.production?.lastCycleTimeMs ?? null, raw.production?.averageCycleTimeMs ?? null,
        JSON.stringify(raw.production?.sampleCounts ?? null), JSON.stringify(raw.production?.risingEdges ?? null),
        raw.time?.plannedProductionTimeMs ?? null, raw.time?.runTimeMs ?? null,
        raw.time?.stoppedTimeMs ?? null, raw.time?.maintenanceTimeMs ?? null, raw.time?.unknownTimeMs ?? null,
        p.referenceCycleTimeMs, p.qualityProductValidated, p.qualityEvidenceStatus, JSON.stringify(raw)],
    );
  }

  async #persistExitEdges(connection, inboxId, samples, record) {
    for (const sample of samples) {
      if (sample.signalKey !== 'PieceAtExit' || sample.valueBool !== true || sample.evidenceStatus !== 'FIELD_VALIDATED' || sample.isFresh !== true || !sample.sampleTimestamp) continue;
      const [futureRows] = await connection.execute(
        `SELECT sample_id FROM telemetry_samples WHERE signal_key='PieceAtExit' AND sample_timestamp > ? LIMIT 1`,
        [sample.sampleTimestamp],
      );
      if (futureRows.length) continue;
      const [priorRows] = await connection.execute(
        `SELECT value_bool, sample_timestamp FROM telemetry_samples
         WHERE signal_key='PieceAtExit' AND sample_timestamp < ?
         ORDER BY sample_timestamp DESC LIMIT 1 FOR UPDATE`, [sample.sampleTimestamp],
      );
      const prior = priorRows[0];
      if (!prior || Number(prior.value_bool) !== 0) continue;
      const eventKey = createHash('sha256').update(
        `PieceAtExit\n${sample.sampleTimestamp.toISOString()}\n${sample.tag ?? ''}\ntrue`,
      ).digest();
      await connection.execute(
        `INSERT IGNORE INTO production_events
         (production_event_id,cps_id,event_key,event_type,signal_key,source_tag,count_delta,source_timestamp,received_at,evidence_status,origin_method,evidence_refs_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidBuffer(), record.cpsId, eventKey, 'piece_counted', sample.signalKey, sample.tag, 1,
          sample.sourceTimestamp, record.receivedAt, sample.evidenceStatus, 'PHYSICAL_RISING_EDGE',
          JSON.stringify({ inboxId: inboxId.toString('hex'), sampleTimestamp: sample.sampleTimestamp.toISOString(), serverTimestamp: sample.serverTimestamp?.toISOString() ?? null })],
      );
    }
  }

  async #persistHealth(connection, inboxId, p, record) {
    await connection.execute(
      `INSERT INTO health_snapshots
       (health_id,cps_id,inbox_id,health_type,producer_component,health_state,score,communication_fresh,evidence_status,calculated_at,payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidBuffer(), record.cpsId, inboxId, p.healthType, p.producerComponent, p.healthState, p.score,
        p.communicationFresh, p.evidenceStatus, p.calculatedAt, JSON.stringify(record.payload)],
    );
  }

  async #persistPpu(connection, p, record) {
    const [insert] = await connection.execute(
      `INSERT IGNORE INTO ppu_events
       (ppu_event_id,cps_id,event_key,event_type,actor_id,source,occurred_at,recorded_at,episode_id,correlation_id,evidence_refs_json,payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidBuffer(), record.cpsId, Buffer.from(p.eventKey, 'hex'), p.eventType, p.actorId, p.source,
        p.occurredAt, record.receivedAt, p.episodeId, p.correlationId,
        JSON.stringify(p.evidence), JSON.stringify(record.payload)],
    );
    return insert.affectedRows === 0;
  }

  async getHealth() { return this.pool.query('SELECT * FROM health_snapshots ORDER BY calculated_at DESC LIMIT 1'); }
  async queryHistory(kind, options = {}) {
    const sources = {
      telemetry: { from: 'telemetry_samples t JOIN mqtt_inbox i ON i.inbox_id=t.inbox_id', select: 't.*', time: 't.sample_timestamp', id: 't.sample_id', cps: 'i.cps_id', signal: 't.signal_key' },
      states: { from: 'operational_state_events h', select: 'h.*', time: 'h.recorded_at', id: 'h.state_event_id', cps: 'h.cps_id' },
      oee: { from: 'oee_snapshots h', select: 'h.*', time: 'h.calculated_at', id: 'h.oee_id', cps: 'h.cps_id' },
      health: { from: 'health_snapshots h', select: 'h.*', time: 'h.calculated_at', id: 'h.health_id', cps: 'h.cps_id' },
      production: { from: 'production_events h', select: 'h.*', time: 'h.received_at', id: 'h.production_event_id', cps: 'h.cps_id' },
      ppu: { from: 'ppu_events h', select: 'h.*', time: 'h.recorded_at', id: 'h.ppu_event_id', cps: 'h.cps_id' },
    };
    const source = sources[kind];
    if (!source) throw new Error('Unsupported history kind.');

    const fail = (message) => { const error = new Error(message); error.statusCode = 400; throw error; };
    const parseDate = (value, name) => {
      if (value === undefined || value === null || value === '') return null;
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) fail(`Invalid ${name} filter.`);
      return date;
    };
    const parseLimit = (value, fallback = 100) => {
      if (value === undefined || value === null || value === '') return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) fail('Invalid history limit.');
      return Math.min(1000, parsed);
    };
    const parseOffset = (value) => {
      if (value === undefined || value === null || value === '') return 0;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10000) fail('Invalid history offset.');
      return parsed;
    };

    const cursorId = options.cursor === undefined || options.cursor === null ? null : options.cursor;
    let cursorState = null;
    if (cursorId) {
      if (typeof cursorId !== 'string' || !/^[0-9a-f-]{36}$/i.test(cursorId)) fail('Invalid or expired history cursor.');
      cursorState = this.historyCursors.get(cursorId);
      if (!cursorState || cursorState.expiresAt <= Date.now()) {
        if (cursorState) await this.#releaseHistoryCursor(cursorId, cursorState);
        fail('Invalid or expired history cursor.');
      }
      if (cursorState.kind !== kind) fail('History cursor is incompatible with the requested kind or filters.');
    }

    const from = (options.from === undefined || options.from === null || options.from === '') && cursorState
      ? cursorState.filters.from : parseDate(options.from, 'from');
    const to = (options.to === undefined || options.to === null || options.to === '') && cursorState
      ? cursorState.filters.to : parseDate(options.to, 'to');
    const signal = (options.signal === undefined || options.signal === null || options.signal === '') && cursorState
      ? cursorState.filters.signal : (options.signal || null);
    const limit = options.limit === undefined || options.limit === null || options.limit === ''
      ? (cursorState?.limit ?? 100) : parseLimit(options.limit);
    const offset = parseOffset(options.offset);
    if (from && to && from >= to) fail('History from filter must be earlier than to.');
    if (signal && !source.signal) fail('Signal filter is only supported for telemetry history.');
    if (cursorState) {
      if (limit !== cursorState.limit || (from?.getTime() ?? null) !== (cursorState.filters.from?.getTime() ?? null) ||
        (to?.getTime() ?? null) !== (cursorState.filters.to?.getTime() ?? null) || signal !== cursorState.filters.signal || offset !== 0) {
        fail('History cursor is incompatible with the requested kind or filters.');
      }
      // A cursor is single-use so concurrent/retried requests cannot fork a traversal.
      this.historyCursors.delete(cursorId);
    }

    const filters = { from, to, signal };
    const connection = cursorState?.connection ?? await this.historyPool.getConnection();
    let nextCursor = null;
    try {
      if (!cursorState) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      }
      const clauses = [`${source.cps} = ?`];
      const params = ['cpslai1'];
      if (from) { clauses.push(`${source.time} >= ?`); params.push(from); }
      if (to) { clauses.push(`${source.time} < ?`); params.push(to); }
      if (signal && source.signal) { clauses.push(`${source.signal} = ?`); params.push(signal); }
      if (cursorState) {
        if (cursorState.lastTime === null) {
          clauses.push(`(${source.time} IS NULL AND ${source.id} < ?)`);
        } else {
          clauses.push(`(${source.time} < ? OR (${source.time} = ? AND ${source.id} < ?) OR ${source.time} IS NULL)`);
        }
        if (cursorState.lastTime !== null) params.push(cursorState.lastTime, cursorState.lastTime);
        params.push(cursorState.lastId);
      }
      params.push(limit + 1);
      const offsetSql = cursorState || offset === 0 ? '' : ' OFFSET ?';
      if (offsetSql) params.push(offset);
      const sql = `SELECT ${source.select} FROM ${source.from} WHERE ${clauses.join(' AND ')} ORDER BY (${source.time} IS NULL) ASC, ${source.time} DESC, ${source.id} DESC LIMIT ?${offsetSql}`;
      const [rows] = await connection.execute(sql, params);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      if (hasMore) {
        if (this.historyCursors.size >= this.maxHistoryCursors) throw new Error('History cursor capacity reached.');
        const last = items.at(-1);
        nextCursor = randomUUID();
        this.historyCursors.set(nextCursor, {
          connection, kind, filters, limit,
          lastTime: last[source.time.split('.').at(-1)],
          lastId: last[source.id.split('.').at(-1)],
          expiresAt: cursorState?.expiresAt ?? Date.now() + this.historyCursorTtlMs,
        });
      } else {
        await connection.commit();
        connection.release();
      }
      return { items, count: items.length, limit, nextCursor, hasMore };
    } catch (error) {
      if (nextCursor) this.historyCursors.delete(nextCursor);
      try { await connection.rollback(); } catch { /* connection may already be closed */ }
      connection.release();
      throw error;
    }
  }

  async #releaseHistoryCursor(cursorId, state) {
    this.historyCursors.delete(cursorId);
    try { await state.connection.rollback(); } catch { /* expired connection */ }
    state.connection.release();
  }

  async #expireHistoryCursors() {
    const now = Date.now();
    for (const [cursorId, state] of this.historyCursors) {
      if (state.expiresAt <= now) await this.#releaseHistoryCursor(cursorId, state);
    }
  }

  async close() {
    clearInterval(this.historyCursorCleanup);
    for (const [cursorId, state] of this.historyCursors) await this.#releaseHistoryCursor(cursorId, state);
    await this.pool.end();
    if (this.historyPool !== this.pool) await this.historyPool.end();
  }
}
