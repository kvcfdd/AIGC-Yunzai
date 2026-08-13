class AigcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = "AigcError"
  }
}

export { AigcError }
