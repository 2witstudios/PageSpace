import { createUserServiceToken, type ServiceScope } from '@pagespace/lib';

const REQUIRED_AVATAR_SCOPES: ServiceScope[] = ['avatars:write'];

export async function createAvatarServiceToken(
  userId: string,
  expirationTime: string
): Promise<{ token: string }> {
  const { token } = await createUserServiceToken(
    userId,
    REQUIRED_AVATAR_SCOPES,
    expirationTime
  );
  return { token };
}
