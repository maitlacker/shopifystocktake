const passport        = require('passport');
const GoogleStrategy  = require('passport-google-oauth20').Strategy;

const ALLOWED_DOMAIN = 'theselfstyler.com';

function configureAuth(app) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value || '';
      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return done(null, false, { message: `Access restricted to @${ALLOWED_DOMAIN} accounts.` });
      }
      return done(null, {
        id:          profile.id,
        displayName: profile.displayName,
        email,
        photo:       profile.photos?.[0]?.value || null,
      });
    }
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  app.use(passport.initialize());
  app.use(passport.session());

  // ── OAuth routes ──────────────────────────────────────────────────
  app.get('/auth/google',
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      hd:    ALLOWED_DOMAIN,        // hints Google to show the right account picker
    })
  );

  app.get('/auth/google/callback',
    passport.authenticate('google', {
      failureRedirect: '/login?error=access_denied',
    }),
    (req, res) => res.redirect('/')
  );

  app.post('/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.redirect('/login');
    });
  });

  // ── Current user API ──────────────────────────────────────────────
  app.get('/api/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorised' });
    res.json(req.user);
  });
}

// Middleware — protect all routes except login + auth
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();

  const publicPaths = ['/login', '/auth/google', '/auth/google/callback', '/api/margin/feed'];
  if (publicPaths.some((p) => req.path.startsWith(p))) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  res.redirect('/login');
}

module.exports = { configureAuth, requireAuth };
