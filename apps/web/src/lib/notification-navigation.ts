export interface NotificationTarget { actionId?: number; chatId?: string }

export function notificationTarget(value: unknown): NotificationTarget {
  if (!value || typeof value !== 'object') return {};
  const data = value as NotificationTarget;
  if (Number.isSafeInteger(data.actionId) && data.actionId! > 0) return { actionId: data.actionId };
  if (typeof data.chatId === 'string' && data.chatId.length > 0 && data.chatId.length <= 128) return { chatId: data.chatId };
  return {};
}

export function notificationUrl(value: unknown): string {
  const target = notificationTarget(value);
  const params = new URLSearchParams();
  if (target.actionId) params.set('notificationAction', String(target.actionId));
  else if (target.chatId) params.set('notificationChat', target.chatId);
  return params.size ? `/?${params}` : '/';
}

export function consumeNotificationTarget(): NotificationTarget {
  const url = new URL(window.location.href);
  const action = url.searchParams.get('notificationAction');
  const target = notificationTarget({ actionId: action ? Number(action) : undefined, chatId: url.searchParams.get('notificationChat') });
  url.searchParams.delete('notificationAction');
  url.searchParams.delete('notificationChat');
  window.history.replaceState({}, '', url.toString());
  return target;
}
