import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Reveal } from '../ui/Reveal'

export function FinalCta() {
  return (
    <section className="bg-background px-4 pb-20 sm:px-6 sm:pb-28">
      <Reveal direction="scale">
        <div className="mk-dark relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] px-6 py-16 text-center shadow-2xl shadow-primary/30 sm:px-12 sm:py-20">
          <div className="mk-blob pointer-events-none absolute -left-20 -top-20 size-72 rounded-full bg-primary/50 blur-3xl" />
          <div className="mk-blob pointer-events-none absolute -bottom-24 -right-16 size-72 rounded-full bg-[#d49a3a]/30 blur-3xl [animation-delay:-8s]" />

          <div className="relative">
            <h2 className="mx-auto max-w-3xl text-3xl font-extrabold tracking-tight sm:text-5xl sm:leading-[1.1]">
              Ready to run a smarter venue?
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base text-white/75 sm:text-lg">
              Create your workspace today and share your booking link with customers the same day.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="mk-shine group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-bold text-primary shadow-lg transition hover:-translate-y-0.5 hover:bg-white/90 sm:w-auto"
              >
                Get started
                <ArrowRight size={18} className="transition-transform group-hover:translate-x-1" />
              </Link>
              <Link
                href="/login"
                className="inline-flex w-full items-center justify-center rounded-xl border border-white/25 px-8 py-3.5 text-base font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/10 sm:w-auto"
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
