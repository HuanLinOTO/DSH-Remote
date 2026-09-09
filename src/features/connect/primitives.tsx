// Small form primitives for the connect screens (kept dependency-free).

import { forwardRef, type InputHTMLAttributes, type ButtonHTMLAttributes } from 'react'

export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { value: string; onChange: (value: string) => void }>(
  function Input({ value, onChange, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        value={value}
        onChange={event => onChange(event.target.value)}
        className={`w-full rounded-md border border-border-200/60 bg-bg-100 px-3 py-2 text-sm text-text-100 outline-none transition-colors placeholder:text-text-400 focus:border-blue-400 ${className ?? ''}`}
        {...rest}
      />
    )
  },
)

export function Button({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`}
      {...rest}
    />
  )
}
