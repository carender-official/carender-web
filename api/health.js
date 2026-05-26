module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      PORTONE_API_KEY:          !!process.env.PORTONE_API_KEY,
      PORTONE_API_SECRET:       !!process.env.PORTONE_API_SECRET,
      SUPABASE_URL:             !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
  })
}
