import { withZipline } from 'lib/middleware/withZipline';
import { getBase64URLFromURL, notNull } from 'lib/util';
import Logger from 'lib/logger';
import config from 'lib/config';
import { discord_auth } from 'lib/oauth';
import { withOAuth, OAuthResponse, OAuthQuery } from 'lib/middleware/withOAuth';

async function handler({ code, state, host }: OAuthQuery): Promise<OAuthResponse> {
  if (!config.features.oauth_registration)
    return {
      error_code: 403,
      error: 'oauth registration is disabled',
    };

  if (!notNull(config.oauth.discord_client_id, config.oauth.discord_client_secret)) {
    Logger.get('oauth').error('Discord OAuth is not configured');
    return {
      error_code: 401,
      error: 'Discord OAuth is not configured',
    };
  }

  if (!code)
    return {
      redirect: discord_auth.oauth_url(
        config.oauth.discord_client_id,
        `${config.core.https ? 'https' : 'http'}://${host}`,
        state
      ),
    };

  const resp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.oauth.discord_client_id,
      client_secret: config.oauth.discord_client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${config.core.https ? 'https' : 'http'}://${host}/api/auth/oauth/discord`,
      scope: 'identify',
    }),
  });
  if (!resp.ok) return { error: 'invalid request' };

  const json = await resp.json();

  if (!json.access_token) return { error: 'no access_token in response' };
  if (!json.refresh_token) return { error: 'no refresh_token in response' };

  const userJson = await discord_auth.oauth_user(json.access_token);
  if (!userJson) return { error: 'invalid user request' };

  const avatar = userJson.avatar
    ? `https://cdn.discordapp.com/avatars/${userJson.id}/${userJson.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${userJson.discriminator % 5}.png`;
  const avatarBase64 = await getBase64URLFromURL(avatar);

  return {
    username: userJson.username,
    avatar: avatarBase64,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
  };
}

export default withZipline(withOAuth('discord', handler));
