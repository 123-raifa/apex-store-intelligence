import { XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, LineChart, Line, CartesianGrid } from 'recharts';
import { ShieldAlert, Activity, Users, ShoppingCart, ShoppingBag, ArrowRight } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Minimal Components
function Card({ className, children }: { className?: string, children: React.ReactNode }) {
  return <div className={cn("bg-white border border-gray-200 rounded-xl shadow-sm", className)}>{children}</div>;
}

export default function App() {
  const [storeId, setStoreId] = useState('ST1076'); // Matches user jsonl sample
  const [metrics, setMetrics] = useState<any>(null);
  const [funnel, setFunnel] = useState<any[]>([]);
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [heat, setHeat] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  
  // Seed the DB only once
  useEffect(() => {
    const seed = async () => {
      // Small sample JSONL mapping
      const sampleEvents = `{"event_type":"entry","id_token":"ID_60001","store_code":"ST1076","camera_id":"cam1","event_timestamp":"2026-03-08T18:10:05.120000","is_staff":false}
{"event_type":"entry","id_token":"ID_60002","store_code":"ST1076","camera_id":"cam1","event_timestamp":"2026-03-08T18:10:22.480000","is_staff":false}
{"event_type":"zone_entered","track_id":"ID_60001","store_code":"ST1076","camera_id":"CAM2","zone_id":"SKINCARE","event_time":"2026-03-08T18:10:45.280000"}
{"event_type":"zone_entered","track_id":"ID_60002","store_code":"ST1076","camera_id":"CAM3","zone_id":"MAKEUP","event_time":"2026-03-08T18:11:02.160000"}
{"queue_join_ts":"2026-03-08T18:13:05.080000","event_type":"BILLING_QUEUE_JOIN","track_id":"ID_60001","store_code":"ST1076"}
{"queue_join_ts":"2026-03-08T18:13:42.360000","event_type":"BILLING_QUEUE_JOIN","track_id":"ID_60002","store_code":"ST1076"}`;

      const samplePos = `order_id,order_date,order_time,store_id,product_id,brand_name,total_amount
1,10-04-2026,12:15:05,ST1076,399945,Faces Canada,302.33
2,10-04-2026,12:15:05,ST1076,353621,Faces Canada,491.77`;
      
      try {
        await fetch('/pos/ingest-csv', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: samplePos })
        });
        await fetch('/events/ingest-jsonl', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: sampleEvents })
        });
      } catch (e) {}
    };
    seed();
  }, []);

  const fetchData = async () => {
    try {
      const [mRes, fRes, hRes, aRes, hlRes] = await Promise.all([
        fetch(`/stores/${storeId}/metrics`),
        fetch(`/stores/${storeId}/funnel`),
        fetch(`/stores/${storeId}/heatmap`),
        fetch(`/stores/${storeId}/anomalies`),
        fetch('/health')
      ]);
      setMetrics(await mRes.json());
      const fBody = await fRes.json();
      setFunnel(fBody.funnel || []);
      setHeat((await hRes.json()).zones || []);
      setAnomalies((await aRes.json()).anomalies || []);
      setHealth((await hlRes.json()));
    } catch(e) {}
  };

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, [storeId]);

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-gray-900 font-sans p-6 md:p-12 selection:bg-indigo-100">
      <header className="max-w-6xl mx-auto flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900 flex items-center space-x-3">
            <Activity className="text-indigo-600 w-8 h-8" />
            <span>Apex Retail Intelligence</span>
          </h1>
          <p className="text-sm font-mono text-gray-500 mt-2 flex items-center space-x-2">
            <span>STORE: {storeId}</span>
            <span>•</span>
            <span className={health?.status === 'healthy' ? 'text-green-600' : 'text-red-500'}>
              SYS_STATUS: {health?.status || 'LOADING...'}
            </span>
          </p>
        </div>
        <div className="bg-gray-100 p-2 rounded-lg flex space-x-2 items-center text-sm shadow-inner">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="font-medium text-gray-600 pr-2">LIVE METRICS</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto space-y-8">
        
        {/* Core Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-6">
            <div className="text-sm font-medium text-gray-500 flex items-center"><Users className="w-4 h-4 mr-2"/> Unique Visitors</div>
            <div className="text-4xl font-bold tracking-tight mt-3">{metrics?.unique_visitors || 0}</div>
          </Card>
          <Card className="p-6">
            <div className="text-sm font-medium text-gray-500 flex items-center"><ShoppingCart className="w-4 h-4 mr-2"/> Conversion Rate</div>
            <div className="text-4xl font-bold tracking-tight mt-3 text-indigo-600">
              {metrics ? (metrics.conversion_rate * 100).toFixed(1) : 0}%
            </div>
          </Card>
          <Card className="p-6">
            <div className="text-sm font-medium text-gray-500 flex items-center"><ShoppingBag className="w-4 h-4 mr-2"/> Avg Queue Depth</div>
            <div className="text-4xl font-bold tracking-tight mt-3">{metrics?.queue_depth || 0}</div>
          </Card>
          <Card className="p-6">
            <div className="text-sm font-medium text-gray-500 flex items-center"><ArrowRight className="w-4 h-4 mr-2"/> Abandonment Rate</div>
            <div className="text-4xl font-bold tracking-tight mt-3">
              {metrics ? (metrics.abandonment_rate * 100).toFixed(1) : 0}%
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          
          <div className="md:col-span-2 space-y-8">
            <Card className="p-6">
              <h2 className="text-lg font-semibold tracking-tight mb-6">Conversion Funnel</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={funnel} layout="vertical" margin={{ top: 0, right: 30, left: 30, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E5E7EB"/>
                    <XAxis type="number" hide />
                    <YAxis dataKey="stage" type="category" axisLine={false} tickLine={false} tick={{fill: '#4B5563', fontSize: 13, fontWeight: 500}} />
                    <Tooltip cursor={{fill: '#F3F4F6'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}/>
                    <Bar dataKey="count" fill="#4F46E5" radius={[0, 4, 4, 0]} barSize={32} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-lg font-semibold tracking-tight mb-6">Zone Interactivity (Dwell x Heat)</h2>
               <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={heat}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB"/>
                    <XAxis dataKey="zone_id" axisLine={false} tickLine={false} tick={{fill: '#6B7280', fontSize: 12}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#6B7280', fontSize: 12}} />
                    <Tooltip cursor={{stroke: '#D1D5DB'}} />
                    <Line type="monotone" dataKey="frequency" stroke="#10B981" strokeWidth={3} dot={{r: 4}} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          
          <div className="space-y-8">
            <Card className="p-6 bg-red-50/50 border-red-100">
              <h2 className="text-lg font-semibold tracking-tight text-red-900 mb-4 flex items-center">
                <ShieldAlert className="w-5 h-5 mr-2 text-red-600" />
                Active Alerts
              </h2>
              {anomalies.length > 0 ? (
                <div className="space-y-4">
                  {anomalies.map((a, i) => (
                    <div key={i} className="p-4 bg-white border border-red-200 rounded-lg shadow-sm">
                      <div className="font-medium text-red-800 text-sm mb-1">{a.type}</div>
                      <p className="text-xs text-gray-600 mb-2">{a.description}</p>
                      <div className="text-xs font-mono bg-red-50 text-red-700 px-2 py-1 rounded inline-block">
                        ACTION: {a.suggested_action}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-500 py-8 text-center bg-white rounded-lg border border-dashed border-gray-200">
                  No active anomalies detected
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
