'use client'

/**
 * Bait field for bots that blindly fill every input they find in the DOM.
 * Positioned off-screen and pulled out of the tab order / accessibility tree
 * so a real visitor (including one using a screen reader or keyboard) never
 * notices it. Wire its value straight into createPublicBooking's `website`
 * field — a non-empty value there is treated as spam server-side.
 */
export function HoneypotField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
      <label>
        Website
        <input
          type="text"
          name="website"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </label>
    </div>
  )
}
