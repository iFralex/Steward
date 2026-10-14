import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationUrl } from '../src/lib/notification-navigation.ts';
test('cold push navigation carries an encoded target without external URLs',()=>{
  assert.equal(notificationUrl({actionId:42}), '/?notificationAction=42');
  assert.equal(notificationUrl({chatId:'chat/one'}), '/?notificationChat=chat%2Fone');
  assert.equal(notificationUrl({actionId:-1,url:'https://evil.test'}), '/');
});
