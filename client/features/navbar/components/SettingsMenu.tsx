"use client"

import { useState, useRef, useEffect } from 'react'
import { Settings as SettingsIcon, Check } from 'lucide-react'
import { useTradeSettings, type SettingKey } from '@/stores/settings'

const ROWS: { key: SettingKey; label: string }[] = [
  { key: 'hidePnl', label: 'Hide PNL' },
  { key: 'hideLiqPrice', label: 'Hide Liquidation Price' },
  { key: 'hideOrderBook', label: 'Hide Order Book' },
]

export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const settings = useTradeSettings()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Settings"
        onClick={() => setOpen((v) => !v)}
        className="w-[34px] h-[34px] grid place-items-center text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
      >
        <SettingsIcon size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[262px] max-w-[calc(100vw-24px)] rounded-[12px] border border-[#2A2A31] bg-[#212128] shadow-[0_20px_40px_rgba(0,0,0,.6)] z-50 overflow-hidden">
          <div className="py-1">
            {ROWS.map((row) => (
              <button
                key={row.key}
                onClick={() => settings.toggle(row.key)}
                className="flex w-full items-center justify-between gap-3 px-4 py-[9px] text-left hover:bg-[#19191A] transition-colors"
              >
                <span className="text-[13px] text-[#a3a3a3]">{row.label}</span>
                <span
                  className={`flex w-4 h-4 items-center justify-center rounded-[4px] border transition-colors ${
                    settings[row.key] ? 'border-[#f5f5f5] bg-[#f5f5f5]' : 'border-[#2A2A31] bg-transparent'
                  }`}
                >
                  {settings[row.key] && <Check size={10} strokeWidth={3.5} className="text-[#19191A]" />}
                </span>
              </button>
            ))}
            <div className="my-1 h-px bg-[#2A2A31]" />
            <button
              onClick={() => settings.reset()}
              className="w-full px-4 py-[9px] text-left text-[13px] font-medium text-[#f5f5f5] hover:bg-[#19191A] transition"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
