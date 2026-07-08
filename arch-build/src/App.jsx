import React, { useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
} from '@xyflow/react'

const C = {
  candidat: '#64748b',
  portal: '#10b981',
  anip: '#06b6d4',
  justice: '#f59e0b',
  dges: '#8b5cf6',
  req: '#0ea5e9',
  resp: '#10b981',
  sse: '#22c55e',
  data: '#94a3b8',
}

function SystemNode({ data }) {
  const c = data.color
  return (
    <div style={{
      background: '#fff', border: `2px solid ${c}`, borderRadius: 12,
      width: data.w || 220, boxShadow: `0 2px 8px ${c}20`, overflow: 'visible',
      fontFamily: 'Inter, sans-serif', position: 'relative',
    }}>
      {data.hL && <Handle type="target" position={Position.Left} id="L" style={{ background: c, width: 10, height: 10, border: '2px solid #fff' }} />}
      {data.hR && <Handle type="source" position={Position.Right} id="R" style={{ background: c, width: 10, height: 10, border: '2px solid #fff' }} />}
      {data.hLb && <Handle type="source" position={Position.Left} id="Lb" style={{ background: c, width: 8, height: 8, border: '2px solid #fff', top: '80%' }} />}
      {data.hRb && <Handle type="target" position={Position.Right} id="Rb" style={{ background: c, width: 8, height: 8, border: '2px solid #fff', top: '80%' }} />}
      {data.hB && <Handle type="source" position={Position.Bottom} id="B" style={{ background: c, width: 10, height: 10, border: '2px solid #fff' }} />}
      <div style={{ background: c, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderRadius: '10px 10px 0 0' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 13, fontWeight: 900, flexShrink: 0,
        }}>{data.letter}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>{data.label}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.sub}</div>
        </div>
      </div>
      <div style={{ padding: '8px 14px' }}>
        <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.5 }}>{data.desc}</div>
        {data.port && (
          <div style={{ marginTop: 6, display: 'inline-block', padding: '2px 8px', borderRadius: 20, background: `${c}12`, color: c, fontSize: 10, fontWeight: 700 }}>Port {data.port}</div>
        )}
        {data.api && (
          <div style={{ marginTop: 4, fontFamily: "'Cascadia Code','Fira Code',monospace", fontSize: 8, color: '#64748b', lineHeight: 1.6 }}>{data.api}</div>
        )}
      </div>
    </div>
  )
}

function DataNode({ data }) {
  const c = data.color || '#94a3b8'
  return (
    <div style={{
      background: '#fff', border: `1px dashed ${c}`, borderRadius: 8,
      padding: '5px 12px', fontFamily: 'Inter, sans-serif', textAlign: 'center',
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)', position: 'relative',
    }}>
      <Handle type="target" position={Position.Top} id="T" style={{ background: c, width: 8, height: 8, border: '2px solid #fff' }} />
      <div style={{ fontSize: 9, fontWeight: 700, color: c }}>{data.label}</div>
      <div style={{ fontSize: 8, color: '#94a3b8', fontFamily: "'Cascadia Code','Fira Code',monospace" }}>{data.sub}</div>
    </div>
  )
}

const nodeTypes = { system: SystemNode, dataNode: DataNode }

export default function App() {
  const nodes = useMemo(() => [
    { id: 'candidat', type: 'system', position: { x: 0, y: 220 }, draggable: true, data: {
      letter: '👤', label: 'Candidat', sub: 'Navigateur Web',
      desc: 'Saisit NPI + diplôme pour postuler.', color: C.candidat, w: 180, hR: true,
    }},
    { id: 'portal', type: 'system', position: { x: 280, y: 170 }, draggable: true, data: {
      letter: 'A', label: 'Portail Web', sub: 'Concours de Bourses',
      desc: 'Interface candidature. Vérifie via ANIP, gère paiement et convocation.',
      color: C.portal, w: 250, port: 3000, api: 'POST /inscrire · POST /paiement',
      hL: true, hR: true, hRb: true, hB: true,
    }},
    { id: 'anip', type: 'system', position: { x: 680, y: 150 }, draggable: true, data: {
      letter: 'B', label: 'ANIP', sub: 'Registre National des Personnes',
      desc: 'Vérifie identité (NPI) et nationalité. Orchestre Justice et DGES.',
      color: C.anip, w: 260, port: 3001, api: 'POST /verifier · CRUD /personnes',
      hL: true, hR: true, hLb: true, hRb: true, hB: true,
    }},
    { id: 'justice', type: 'system', position: { x: 1100, y: 0 }, draggable: true, data: {
      letter: 'C', label: 'Justice', sub: 'Casier Judiciaire',
      desc: 'Vérifie casier VIERGE ou NON_VIERGE.',
      color: C.justice, w: 210, port: 3002, api: 'GET /casier/:npi',
      hL: true, hRb: true, hB: true,
    }},
    { id: 'dges', type: 'system', position: { x: 1100, y: 320 }, draggable: true, data: {
      letter: 'D', label: 'DGES', sub: 'Registre des Diplômes',
      desc: 'Authentifie diplôme et correspondance NPI.',
      color: C.dges, w: 210, port: 3003, api: 'POST /diplome/verifier',
      hL: true, hRb: true, hB: true,
    }},
    { id: 'dp', type: 'dataNode', position: { x: 350, y: 500 }, draggable: true, data: { label: 'Base de données', sub: 'Inscriptions, Paiements', color: C.portal } },
    { id: 'db', type: 'dataNode', position: { x: 760, y: 480 }, draggable: true, data: { label: 'Référentiel', sub: 'Registre personnes (NPI)', color: C.anip } },
    { id: 'dc', type: 'dataNode', position: { x: 1160, y: 240 }, draggable: true, data: { label: 'Référentiel', sub: 'Casiers judiciaires', color: C.justice } },
    { id: 'dd', type: 'dataNode', position: { x: 1160, y: 560 }, draggable: true, data: { label: 'Référentiel', sub: 'Diplômes nationaux', color: C.dges } },
  ], [])

  const edges = useMemo(() => [
    // === FLUX DEMANDE (gauche → droite, flèches pleines) ===
    { id: 'r1', source: 'candidat', target: 'portal', sourceHandle: 'R', targetHandle: 'L', type: 'smoothstep',
      label: 'OUT Candidat → IN A-PORTAL', labelStyle: { fill: '#475569', fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: '#fff', fillOpacity: 0.95 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: C.req, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: C.req, width: 14, height: 14 } },
    { id: 'r2', source: 'portal', target: 'anip', sourceHandle: 'R', targetHandle: 'L', type: 'smoothstep',
      label: 'OUT A-PORTAL → IN B-ANIP', labelStyle: { fill: '#0891b2', fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: '#e0f2fe', fillOpacity: 0.95 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: C.req, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: C.req, width: 14, height: 14 } },
    { id: 'r3', source: 'anip', target: 'justice', sourceHandle: 'R', targetHandle: 'L', type: 'smoothstep',
      label: 'OUT B-ANIP → IN C-JUSTICE', labelStyle: { fill: '#b45309', fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: '#fef3c7', fillOpacity: 0.95 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: C.justice, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: C.justice, width: 14, height: 14 } },
    { id: 'r4', source: 'anip', target: 'dges', sourceHandle: 'R', targetHandle: 'L', type: 'smoothstep',
      label: 'OUT B-ANIP → IN D-DGES', labelStyle: { fill: '#6d28d9', fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: '#ede9fe', fillOpacity: 0.95 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      style: { stroke: C.dges, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: C.dges, width: 14, height: 14 } },

    // === FLUX RÉPONSE (droite → gauche, flèches pointillées, handles du bas) ===
    { id: 's1', source: 'justice', target: 'anip', sourceHandle: 'Rb', targetHandle: 'Lb', type: 'smoothstep',
      label: 'OUT C-JUSTICE → IN B-ANIP | "VIERGE"', labelStyle: { fill: '#16a34a', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#f0fdf4', fillOpacity: 0.95 }, labelBgPadding: [4, 2], labelBgBorderRadius: 3,
      style: { stroke: C.resp, strokeWidth: 2, strokeDasharray: '6 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.resp, width: 12, height: 12 } },
    { id: 's2', source: 'dges', target: 'anip', sourceHandle: 'Rb', targetHandle: 'Lb', type: 'smoothstep',
      label: 'OUT D-DGES → IN B-ANIP | "AUTHENTIQUE"', labelStyle: { fill: '#16a34a', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#f0fdf4', fillOpacity: 0.95 }, labelBgPadding: [4, 2], labelBgBorderRadius: 3,
      style: { stroke: C.resp, strokeWidth: 2, strokeDasharray: '6 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.resp, width: 12, height: 12 } },
    { id: 's3', source: 'anip', target: 'portal', sourceHandle: 'Lb', targetHandle: 'Rb', type: 'smoothstep',
      label: 'OUT B-ANIP → IN A-PORTAL | "Succès consolidé"', labelStyle: { fill: '#16a34a', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#f0fdf4', fillOpacity: 0.95 }, labelBgPadding: [4, 2], labelBgBorderRadius: 3,
      style: { stroke: C.resp, strokeWidth: 2, strokeDasharray: '6 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.resp, width: 12, height: 12 } },

    // === PERSISTANCE ===
    { id: 'd1', source: 'portal', target: 'dp', sourceHandle: 'B', targetHandle: 'T', type: 'smoothstep',
      label: 'Écriture', labelStyle: { fill: C.data, fontSize: 9 }, labelBgStyle: { fill: '#fff', fillOpacity: 0.8 },
      labelBgPadding: [3, 1], labelBgBorderRadius: 3,
      style: { stroke: C.data, strokeWidth: 1, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.data, width: 8, height: 8 } },
    { id: 'd2', source: 'anip', target: 'db', sourceHandle: 'B', targetHandle: 'T', type: 'smoothstep',
      label: 'Écriture', labelStyle: { fill: C.data, fontSize: 9 }, labelBgStyle: { fill: '#fff', fillOpacity: 0.8 },
      labelBgPadding: [3, 1], labelBgBorderRadius: 3,
      style: { stroke: C.data, strokeWidth: 1, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.data, width: 8, height: 8 } },
    { id: 'd3', source: 'justice', target: 'dc', sourceHandle: 'B', targetHandle: 'T', type: 'smoothstep',
      label: 'Écriture', labelStyle: { fill: C.data, fontSize: 9 }, labelBgStyle: { fill: '#fff', fillOpacity: 0.8 },
      labelBgPadding: [3, 1], labelBgBorderRadius: 3,
      style: { stroke: C.data, strokeWidth: 1, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.data, width: 8, height: 8 } },
    { id: 'd4', source: 'dges', target: 'dd', sourceHandle: 'B', targetHandle: 'T', type: 'smoothstep',
      label: 'Écriture', labelStyle: { fill: C.data, fontSize: 9 }, labelBgStyle: { fill: '#fff', fillOpacity: 0.8 },
      labelBgPadding: [3, 1], labelBgBorderRadius: 3,
      style: { stroke: C.data, strokeWidth: 1, strokeDasharray: '4 3' },
      markerEnd: { type: MarkerType.ArrowClosed, color: C.data, width: 8, height: 8 } },
  ], [])

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      fitView={true} fitViewOptions={{ padding: 0.3 }}
      minZoom={0.2} maxZoom={2}
      nodesDraggable={true}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#e2e8f0" gap={24} size={1} />
      <Controls position="bottom-right" />
    </ReactFlow>
  )
}
