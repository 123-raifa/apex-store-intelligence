import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { z } from 'zod';
import path from 'path';
import { createServer as createViteServer } from 'vite';

export const db = new Database(process.env.NODE_ENV === 'test' ? ':memory:' : 'data.sqlite');

db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    store_id TEXT,
    camera_id TEXT,
    visitor_id TEXT,
    event_type TEXT,
    timestamp DATETIME,
    zone_id TEXT,
    dwell_ms INTEGER,
    is_staff INTEGER,
    confidence REAL,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_events_store_time ON events(store_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);

  CREATE TABLE IF NOT EXISTS pos_transactions (
    transaction_id TEXT PRIMARY KEY,
    store_id TEXT,
    timestamp DATETIME,
    basket_value_inr REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pos_store_time ON pos_transactions(store_id, timestamp);

  CREATE TABLE IF NOT EXISTS visitor_mappings (
    original_id TEXT PRIMARY KEY,
    mapped_id TEXT
  );
`);

// Auto-ingest seed data on new machines explicitly on module load under development
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  try {
    const fs = require('fs');
    const path = require('path');
    const eventsPath = path.join(process.cwd(), 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
       const count = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as any;
       if (count.cnt === 0) {
          console.log('Database empty. Auto-ingesting events.jsonl...');
          const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n');
          const batch: any[] = [];
          lines.forEach((line: string) => {
            if (line.trim()) batch.push(JSON.parse(line));
          });

          const insertMany = db.transaction((events: any[]) => {
            const stmt = db.prepare(`
              INSERT OR IGNORE INTO events 
              (event_id, store_id, camera_id, visitor_id, event_type, timestamp, zone_id, dwell_ms, is_staff, confidence, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            let inserted = 0;
            for (const e of events) {
               const res = stmt.run(e.event_id || Math.random().toString(36).substring(7), e.store_id || 'ST1076', e.camera_id || null, e.visitor_id, e.event_type, e.timestamp, e.zone_id || null, e.dwell_ms || null, e.is_staff?1:0, e.confidence || null, e.metadata?JSON.stringify(e.metadata):null);
               if (res.changes) inserted++;
            }
            return inserted;
          });
          const ingested = insertMany(batch);
          console.log(`Auto-seeded ${ingested} events from events.jsonl`);
       }
    }
  } catch(e) {
    console.error('Failed to auto-seed base data:', e);
  }
}


// Zod schemas
const EventSchema = z.object({
  event_id: z.string().uuid().or(z.string()),
  store_id: z.string(),
  camera_id: z.string().optional(),
  visitor_id: z.string(),
  event_type: z.string(),
  timestamp: z.string(),
  zone_id: z.string().nullable().optional(),
  dwell_ms: z.number().nullable().optional(),
  is_staff: z.boolean().default(false),
  confidence: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional()
});

const IngestBatchSchema = z.array(EventSchema).max(500);

const setupApp = () => {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Middleware for structured logging
  app.use((req, res, next) => {
    const start = Date.now();
    const trace_id = Math.random().toString(36).substring(7);
    res.on('finish', () => {
      const latency_ms = Date.now() - start;
      const event_count = Array.isArray(req.body) ? req.body.length : undefined;
      const store_id = req.params.id || req.body?.[0]?.store_id || 'unknown';
      console.log(JSON.stringify({
        trace_id,
        store_id,
        endpoint: req.originalUrl,
        latency_ms,
        event_count,
        status_code: res.statusCode
      }));
    });
    next();
  });

  // REST API Endpoints

  // POST /events/ingest
  app.post('/events/ingest', (req, res) => {
    try {
      const rawBatch = Array.isArray(req.body) ? req.body : [];
      const batch: any[] = [];
      const errors: any[] = [];
      rawBatch.forEach((item, index) => {
         const parsed = EventSchema.safeParse(item);
         if (parsed.success) {
           batch.push(parsed.data);
         } else {
           errors.push({ index, errors: parsed.error.issues });
         }
      });
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO events 
        (event_id, store_id, camera_id, visitor_id, event_type, timestamp, zone_id, dwell_ms, is_staff, confidence, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((events: z.infer<typeof EventSchema>[]) => {
        let inserted = 0;
        
        const mapStmt = db.prepare(`SELECT mapped_id FROM visitor_mappings WHERE original_id = ?`);
        const setMapStmt = db.prepare(`INSERT OR IGNORE INTO visitor_mappings (original_id, mapped_id) VALUES (?, ?)`);
        
        // Find recent exit for re-entry deduplication (8-minute radius)
        const findRecentExit = db.prepare(`
          SELECT visitor_id FROM events 
          WHERE store_id = ? AND event_type = 'ZONE_EXIT' AND datetime(timestamp) >= datetime(?, '-8 minutes') AND datetime(timestamp) <= datetime(?)
          ORDER BY timestamp DESC LIMIT 1
        `);

        // Find recent entry on a different camera for cross-camera deduplication (30 seconds)
        const findRecentEntryOtherCam = db.prepare(`
          SELECT visitor_id FROM events 
          WHERE store_id = ? AND event_type = 'ENTRY' AND camera_id IS NOT NULL AND camera_id != ? AND datetime(timestamp) >= datetime(?, '-30 seconds') AND datetime(timestamp) <= datetime(?)
          ORDER BY timestamp DESC LIMIT 1
        `);

        for (const event of events) {
          let mapped_id = event.visitor_id;
          const existingMap = mapStmt.get(event.visitor_id) as any;
          if (existingMap) {
            mapped_id = existingMap.mapped_id;
          } else if (event.event_type === 'ENTRY') {
             const recent = findRecentExit.get(event.store_id, event.timestamp, event.timestamp) as any;
             const recentCam = event.camera_id ? findRecentEntryOtherCam.get(event.store_id, event.camera_id, event.timestamp, event.timestamp) as any : null;
             
             if (recent) {
                mapped_id = recent.visitor_id;
                stmt.run(
                   Math.random().toString(36).substring(7),
                   event.store_id,
                   event.camera_id || null,
                   mapped_id,
                   'REENTRY',
                   event.timestamp,
                   null,
                   0,
                   event.is_staff ? 1 : 0,
                   event.confidence || null,
                   null
                );
             } else if (recentCam) {
                mapped_id = recentCam.visitor_id;
             }
             setMapStmt.run(event.visitor_id, mapped_id);
          } else {
             setMapStmt.run(event.visitor_id, mapped_id);
          }

          const res = stmt.run(
            event.event_id,
            event.store_id,
            event.camera_id || null,
            mapped_id,
            event.event_type,
            event.timestamp,
            event.zone_id || null,
            event.dwell_ms || 0,
            event.is_staff ? 1 : 0,
            event.confidence || null,
            event.metadata ? JSON.stringify(event.metadata) : null
          );
          if (res.changes > 0) inserted++;
        }
        return inserted;
      });

      const insertedCount = insertMany(batch);
      res.status(200).json({ status: 'success', ingested: insertedCount, total_received: rawBatch.length, errors: errors.length > 0 ? errors : undefined });
    } catch (error) {
      console.error(error);
      res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
  });

  // GET /health
  app.get('/health', (req, res) => {
    try {
      const dbStatus = db.open ? 'healthy' : 'unhealthy';
      
      const lastEventStmt = db.prepare('SELECT store_id, MAX(timestamp) as last_event FROM events GROUP BY store_id');
      const lastEvents = lastEventStmt.all() as { store_id: string, last_event: string }[];
      
      const now = new Date();
      const storeStatus = lastEvents.map(e => {
        const lastEvtTime = new Date(e.last_event);
        const lagMin = (now.getTime() - lastEvtTime.getTime()) / (1000 * 60);
        return {
          store_id: e.store_id,
          last_event_timestamp: e.last_event,
          stale_feed: lagMin > 10
        };
      });

      res.status(200).json({
        status: dbStatus,
        stores: storeStatus
      });
    } catch (e) {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // GET /stores/{id}/metrics
  app.get('/stores/:id/metrics', (req, res) => {
    const store_id = req.params.id;
    try {
      // Unique visitors (excluding staff)
      const visitorsStmt = db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) as count 
        FROM events 
        WHERE store_id = ? AND is_staff = 0 AND event_type IN ('ENTRY', 'ZONE_ENTER')
      `);
      const unique_visitors = (visitorsStmt.get(store_id) as any).count;

      // Avg Dwell Time
      const dwellStmt = db.prepare(`
        SELECT zone_id, AVG(dwell_ms) as avg_dwell 
        FROM events 
        WHERE store_id = ? AND is_staff = 0 AND event_type = 'ZONE_DWELL'
        GROUP BY zone_id
      `);
      const zone_dwells = dwellStmt.all(store_id);

      // Conversion Rate estimation:
      // Correlate visitors in BILLING queue with POS transactions occurring shortly after
      const posStmt = db.prepare(`
        SELECT COUNT(DISTINCT e.visitor_id) as converted
        FROM events e
        JOIN pos_transactions p ON e.store_id = p.store_id
        WHERE e.store_id = ? 
          AND e.event_type = 'BILLING_QUEUE_JOIN'
          AND datetime(p.timestamp) >= datetime(e.timestamp)
          AND datetime(p.timestamp) <= datetime(e.timestamp, '+5 minutes')
      `);
      const purchases = (posStmt.get(store_id) as any).converted;
      
      const queueStmt = db.prepare(`
        SELECT json_extract(metadata, '$.queue_depth') as queue_depth 
        FROM events 
        WHERE store_id = ? AND event_type IN ('BILLING_QUEUE_JOIN', 'BILLING_QUEUE_ABANDON') AND metadata IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      `);
      const lastQueue = queueStmt.get(store_id) as any;

      // Abandonment Rate
      const abandonStmt = db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN event_type = 'BILLING_QUEUE_ABANDON' THEN 1 ELSE 0 END), 0) as abandons,
          COALESCE(SUM(CASE WHEN event_type = 'BILLING_QUEUE_JOIN' THEN 1 ELSE 0 END), 0) as joins
        FROM events WHERE store_id = ? AND is_staff = 0
      `);
      const abandonment = abandonStmt.get(store_id) as any || { abandons: 0, joins: 0 };
      const abandonment_rate = abandonment.joins > 0 ? (abandonment.abandons / abandonment.joins) : 0;

      res.status(200).json({
        store_id,
        unique_visitors,
        conversion_rate: unique_visitors > 0 ? purchases / unique_visitors : 0,
        purchases,
        queue_depth: lastQueue ? lastQueue.queue_depth : 0,
        abandonment_rate,
        zone_dwells
      });
    } catch(e) {
      console.error(e);
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // GET /stores/{id}/funnel
  app.get('/stores/:id/funnel', (req, res) => {
    const storeId = req.params.id;
    try {
      const funnel = db.prepare(`
        SELECT 
          COUNT(DISTINCT CASE WHEN event_type = 'ENTRY' THEN visitor_id END) as entry,
          COUNT(DISTINCT CASE WHEN event_type = 'ZONE_ENTER' OR event_type = 'ZONE_DWELL' THEN visitor_id END) as zone_visit,
          COUNT(DISTINCT CASE WHEN event_type = 'BILLING_QUEUE_JOIN' THEN visitor_id END) as billing_queue
        FROM events WHERE store_id = ? AND is_staff = 0
      `).get(storeId) as any;

      const posCntGroup = db.prepare(`
        SELECT COUNT(DISTINCT e.visitor_id) as cnt
        FROM events e
        JOIN pos_transactions p ON e.store_id = p.store_id
        WHERE e.store_id = ? 
          AND e.event_type = 'BILLING_QUEUE_JOIN'
          AND datetime(p.timestamp) >= datetime(e.timestamp)
          AND datetime(p.timestamp) <= datetime(e.timestamp, '+5 minutes')
      `).get(storeId) as any;
      const posCnt = posCntGroup ? posCntGroup.cnt : 0;

      const stages = [
        { stage: 'Entry', count: funnel.entry, dropoff_pct: 0 },
        { stage: 'Zone Visit', count: funnel.zone_visit, dropoff_pct: funnel.entry > 0 ? 1 - (funnel.zone_visit/funnel.entry) : 0 },
        { stage: 'Billing Queue', count: funnel.billing_queue, dropoff_pct: funnel.zone_visit > 0 ? 1 - (funnel.billing_queue/funnel.zone_visit) : 0 },
        { stage: 'Purchase', count: posCnt, dropoff_pct: funnel.billing_queue > 0 ? Math.max(0, 1 - (posCnt/funnel.billing_queue)) : 0 }
      ];

      res.json({ store_id: storeId, funnel: stages });
    } catch(e){
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // GET /stores/{id}/heatmap
  app.get('/stores/:id/heatmap', (req, res) => {
    const storeId = req.params.id;
    try {
      const data = db.prepare(`
        SELECT zone_id, COUNT(*) as frequency, AVG(dwell_ms) as avg_dwell
        FROM events WHERE store_id = ? AND zone_id IS NOT NULL AND is_staff = 0
        GROUP BY zone_id
      `).all(storeId) as any[];

      const totalSessions = (db.prepare(`SELECT COUNT(DISTINCT visitor_id) as cnt FROM events WHERE store_id = ?`).get(storeId) as any).cnt;

      const maxFreq = Math.max(...data.map(d => d.frequency), 1);
      const normalizedData = data.map(d => ({
        ...d,
        normalized_heat: (d.frequency / maxFreq) * 100
      }));

      res.json({
        store_id: storeId,
        zones: normalizedData,
        data_confidence: totalSessions < 20 ? 'LOW' : 'HIGH',
        total_sessions: totalSessions
      });
    } catch(e) {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // GET /stores/{id}/anomalies
  app.get('/stores/:id/anomalies', (req, res) => {
    const storeId = req.params.id;
    try {
      const anomalies = [];

      const lastQueueEvt = db.prepare(`
        SELECT json_extract(metadata, '$.queue_depth') as depth, timestamp 
        FROM events WHERE store_id = ? AND event_type = 'BILLING_QUEUE_JOIN' AND metadata IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      `).get(storeId) as any;

      if (lastQueueEvt && lastQueueEvt.depth >= 5) {
        anomalies.push({
          type: 'BILLING_QUEUE_SPIKE',
          severity: 'CRITICAL',
          description: `Queue depth has reached ${lastQueueEvt.depth}.`,
          suggested_action: 'Deploy additional staff to billing.'
        });
      }

      const deadZones = db.prepare(`
        SELECT zone_id, MAX(timestamp) as last_seen 
        FROM events WHERE store_id = ? AND zone_id IS NOT NULL 
        GROUP BY zone_id
      `).all(storeId) as any[];

      const nowStr = new Date().toISOString(); 
      // For a real app we'd use current time, since events might be backdated in demo, we'll check relative to max time
      const maxTimeEvent = db.prepare(`SELECT MAX(timestamp) as max_time FROM events WHERE store_id = ?`).get(storeId) as any;
      const refTime = maxTimeEvent && maxTimeEvent.max_time ? new Date(maxTimeEvent.max_time).getTime() : Date.now();

      for (const dz of deadZones) {
        const diffMins = (refTime - new Date(dz.last_seen).getTime()) / (1000 * 60);
        if (diffMins > 30) {
          anomalies.push({
            type: 'DEAD_ZONE',
            severity: 'WARN',
            description: `No visits in zone ${dz.zone_id} for over 30 minutes.`,
            suggested_action: 'Check camera feed or clear aisle blockages.'
          });
        }
      }

      // Compute today's conversion vs past average
      const convStats = db.prepare(`
        WITH daily_visitors AS (
          SELECT date(timestamp) as day, COUNT(DISTINCT visitor_id) as visitors
          FROM events
          WHERE store_id = ? AND is_staff = 0 AND event_type IN ('ENTRY', 'ZONE_ENTER')
          GROUP BY day
        ),
        daily_converters AS (
          SELECT date(e.timestamp) as day, COUNT(DISTINCT e.visitor_id) as converters
          FROM events e
          JOIN pos_transactions p ON e.store_id = p.store_id
          WHERE e.store_id = ? 
            AND e.event_type = 'BILLING_QUEUE_JOIN'
            AND datetime(p.timestamp) >= datetime(e.timestamp)
            AND datetime(p.timestamp) <= datetime(e.timestamp, '+5 minutes')
          GROUP BY day
        ),
        daily_stats AS (
          SELECT v.day, v.visitors, COALESCE(c.converters, 0) as converters,
                 CAST(COALESCE(c.converters, 0) AS REAL) / NULLIF(v.visitors, 0) as conv_rate
          FROM daily_visitors v
          LEFT JOIN daily_converters c ON v.day = c.day
        ),
        max_date AS (
          SELECT MAX(day) as last_day FROM daily_stats
        )
        SELECT 
           AVG(CASE WHEN day < m.last_day THEN conv_rate END) as avg_past,
           MAX(CASE WHEN day = m.last_day THEN conv_rate END) as today_conv
        FROM daily_stats, max_date m
      `).get(storeId, storeId) as any;

      if (convStats && convStats.today_conv !== null && convStats.avg_past !== null) {
         const drop = convStats.avg_past - convStats.today_conv;
         if (drop > 0.1) {
            anomalies.push({
               type: 'CONVERSION_DROP',
               severity: drop > 0.2 ? 'CRITICAL' : 'WARN',
               description: `Conversion rate dropped.`,
               suggested_action: 'Investigate billing queue friction.'
            });
         } else {
            anomalies.push({
               type: 'CONVERSION_DROP',
               severity: 'INFO',
               description: 'Conversion rate is stable compared to past avg.',
               suggested_action: 'None'
            });
         }
      } else {
         anomalies.push({
            type: 'CONVERSION_DROP',
            severity: 'INFO',
            description: 'Not enough historical data to compare conversion rates.',
            suggested_action: 'None'
         });
      }

      res.json({ store_id: storeId, anomalies });
    } catch(e) {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  // Helper POST endpoint to ingest raw POS CSV records (For hackathon validation setup)
  app.post('/pos/ingest-csv', (req, res) => {
    try {
      const csvData = req.body.csv as string;
      const lines = csvData.trim().split('\n');
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO pos_transactions (transaction_id, store_id, timestamp, basket_value_inr)
        VALUES (?, ?, ?, ?)
      `);

      let inserted = 0;
      db.transaction(() => {
        for(let i=0; i<lines.length; i++){
          const cols = lines[i].split(',');
          if(cols[0] === 'order_id' || cols[0] === 'store_id') continue;
          
          if(cols.length >= 4) {
             let storeId, trxId, timestampStr, basketValue;
             if(cols.length >= 7) {
               trxId = cols[0];
               storeId = cols[3];
               timestampStr = cols[1] + 'T' + cols[2];
               basketValue = parseFloat(cols[6]);
             } else {
               storeId = cols[0];
               trxId = cols[1];
               timestampStr = cols[2];
               basketValue = parseFloat(cols[3]);
             }

             if(storeId && trxId) {
                const rs = stmt.run(trxId, storeId, timestampStr, basketValue);
                if(rs.changes) inserted++;
             }
          }
        }
      })();
      res.json({ status: 'success', inserted });
    } catch (e) {
      console.error(e);
      res.status(500).json({ status: 'error', message: 'Failed POS ingest' });
    }
  });

  app.post('/events/ingest-jsonl', (req, res) => {
    try {
      const text = req.body.data as string;
      const lines = text.split('\n');
      const batch: any[] = [];
      
      lines.forEach((line) => {
        if (!line.trim()) return;
        const o = JSON.parse(line);
        const ev = {
          event_id: Math.random().toString(36).substring(7),
          store_id: o.store_code || o.store_id,
          camera_id: o.camera_id,
          visitor_id: o.id_token || `TRK_${o.track_id}`,
          event_type: o.event_type.toUpperCase().replace('_ENTERED', '_ENTER').replace('_EXITED', '_EXIT').replace('ENTRY', 'ENTRY'),
          timestamp: o.event_timestamp || o.event_time || o.queue_join_ts || new Date().toISOString(),
          zone_id: o.zone_id || null,
          dwell_ms: o.wait_seconds ? o.wait_seconds * 1000 : null,
          is_staff: !!o.is_staff,
          confidence: 0.9,
          metadata: o.zone_name ? { sku_zone: o.zone_name, queue_depth: o.queue_position_at_join } : null
        };
        batch.push(ev);
      });

      const insertMany = db.transaction((events: any[]) => {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO events 
          (event_id, store_id, camera_id, visitor_id, event_type, timestamp, zone_id, dwell_ms, is_staff, confidence, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const mapStmt = db.prepare(`SELECT mapped_id FROM visitor_mappings WHERE original_id = ?`);
        const setMapStmt = db.prepare(`INSERT OR IGNORE INTO visitor_mappings (original_id, mapped_id) VALUES (?, ?)`);
        
        const findRecentExit = db.prepare(`
          SELECT visitor_id FROM events 
          WHERE store_id = ? AND event_type = 'ZONE_EXIT' AND datetime(timestamp) >= datetime(?, '-8 minutes') AND datetime(timestamp) <= datetime(?)
          ORDER BY timestamp DESC LIMIT 1
        `);

        let inserted = 0;
        for (const e of events) {
          let mapped_id = e.visitor_id;
          const existingMap = mapStmt.get(e.visitor_id) as any;
          if (existingMap) {
            mapped_id = existingMap.mapped_id;
          } else if (e.event_type === 'ENTRY') {
             const recent = findRecentExit.get(e.store_id, e.timestamp, e.timestamp) as any;
             if (recent) {
                mapped_id = recent.visitor_id;
             }
             setMapStmt.run(e.visitor_id, mapped_id);
          } else {
             setMapStmt.run(e.visitor_id, mapped_id);
          }

          try {
            const res = stmt.run(e.event_id, e.store_id, e.camera_id, mapped_id, e.event_type, e.timestamp, e.zone_id, e.dwell_ms, e.is_staff?1:0, e.confidence, e.metadata?JSON.stringify(e.metadata):null);
            inserted++;
          } catch(err){}
        }
        return inserted;
      });
      res.json({ inserted: insertMany(batch) });
    } catch(e) {
      console.error(e);
      res.status(500).json({ status: 'error' });
    }
  });


  return app;
};

export const app = setupApp();

const startServer = async () => {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
};

if (process.env.NODE_ENV !== "test") {
  startServer();
}
