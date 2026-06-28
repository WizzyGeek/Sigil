import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-black flex items-center justify-center font-sans text-[#f4f1ea]">
          <div className="glass rounded-2xl p-8 max-w-lg w-full text-center">
            <div className="text-gold font-bold tracking-widest text-base mb-4">SIGIL</div>
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <pre className="text-white/40 text-xs text-left bg-white/5 rounded-lg p-4 overflow-auto mb-6 max-h-48">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-6 py-2.5 bg-gold text-black font-semibold rounded-xl hover:bg-gold-light transition-colors text-sm"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
