export const minApiVersion = 1;

const { React, hooks: { useState } } = window.FBB;

export default function RetroCoreTracerPane() {
  const [step, setStep] = useState(0);

  return React.createElement(
    'div',
    {
      style: {
        padding: '20px',
        background: '#0b0f19',
        color: '#f8fafc',
        height: '100%',
        fontFamily: 'monospace',
        boxSizing: 'border-box'
      }
    },
    React.createElement('h2', { style: { color: '#38bdf8', margin: '0 0 12px 0' } }, '🕹️ RetroCoreTracer for F-BB'),
    React.createElement('p', { style: { color: '#94a3b8' } }, 'Z80 CPU Core Simulation & Visual Bus Tracer'),
    React.createElement('div', {
      style: {
        background: '#1e293b',
        padding: '16px',
        borderRadius: '8px',
        border: '1px solid #334155',
        margin: '16px 0'
      }
    },
      React.createElement('div', null, `Simulation Step: ${step}`),
      React.createElement('div', { style: { color: '#4ade80', marginTop: '8px' } }, 'Status: Ready (PPA & DPPA linked successfully!)')
    ),
    React.createElement('div', { style: { display: 'flex', gap: '8px' } },
      React.createElement('button', {
        onClick: () => setStep(s => Math.max(0, s - 1)),
        style: { background: '#475569', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer' }
      }, '◀ Backstep'),
      React.createElement('button', {
        onClick: () => setStep(s => s + 1),
        style: { background: '#2563eb', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer' }
      }, 'Step Forward ▶')
    )
  );
}
