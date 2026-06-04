import * as fs from 'fs';
import { randomUUID } from 'crypto';

const store_id = 'ST1076';
const num_events = 217;

let out = [];
// Create timeline of events
let time = new Date("2026-06-04T08:00:00Z").getTime();

for(let i=1; i<=num_events; i++) {
   time += Math.random() * 10000;
   const visitor_id = randomUUID();
   const is_staff = Math.random() < 0.05;
   
   // entry
   out.push({
      event_id: randomUUID(),
      store_id: store_id,
      visitor_id: visitor_id,
      event_type: 'ENTRY',
      timestamp: new Date(time).toISOString(),
      confidence: 0.9 + Math.random() * 0.1,
      is_staff: is_staff
   });
   
   if (is_staff) { continue; }
   
   // Some dwell
   let zones = ['MENS', 'WOMENS', 'SHOES'];
   let chosen = zones[Math.floor(Math.random() * zones.length)];
   
   time += 5000 + Math.random() * 20000;
   out.push({
      event_id: randomUUID(),
      store_id: store_id,
      visitor_id: visitor_id,
      event_type: 'ZONE_ENTER',
      zone_id: chosen,
      timestamp: new Date(time).toISOString(),
      confidence: 0.9 + Math.random() * 0.1,
      is_staff: false
   });
   
   const dwell_duration = 10000 + Math.random() * 60000;
   time += dwell_duration;
   out.push({
      event_id: randomUUID(),
      store_id: store_id,
      visitor_id: visitor_id,
      event_type: 'ZONE_DWELL',
      zone_id: chosen,
      dwell_ms: Math.floor(dwell_duration),
      timestamp: new Date(time).toISOString()
   });
   
   // Some percentage might convert
   if (Math.random() > 0.5) {
      time += 5000 + Math.random() * 10000;
      out.push({
         event_id: randomUUID(),
         store_id: store_id,
         visitor_id: visitor_id,
         event_type: 'BILLING_QUEUE_JOIN',
         timestamp: new Date(time).toISOString(),
         confidence: 0.95,
         is_staff: false,
         metadata: { queue_depth: 1 } 
      });
      time += Math.random() * 30000;
      // Some percentage abandons, some drop off
      if (Math.random() > 0.1) {
          out.push({
             event_id: randomUUID(),
             store_id: store_id,
             visitor_id: visitor_id,
             event_type: 'CHECKOUT_START',
             timestamp: new Date(time).toISOString(),
             confidence: 0.95,
             is_staff: false
          });
      } else {
          out.push({
             event_id: randomUUID(),
             store_id: store_id,
             visitor_id: visitor_id,
             event_type: 'BILLING_QUEUE_ABANDON',
             timestamp: new Date(time).toISOString(),
             confidence: 0.95,
             is_staff: false,
             metadata: { queue_depth: 0 }
          });
      }
   }
}

fs.writeFileSync('output-events.jsonl', out.map(o => JSON.stringify(o)).join('\n'));
console.log('Done');
