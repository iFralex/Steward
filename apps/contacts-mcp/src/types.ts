export interface ContactEmail { address: string; label: string | null }
export interface ContactPhone { number: string; label: string | null }

export interface Contact {
  uid: string;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  nickname: string | null;
  note: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  sources: string[];
}

export interface ResolvedRecipient {
  uid: string;
  displayName: string;
  organization: string | null;
  email: string;
  score: number;
}
