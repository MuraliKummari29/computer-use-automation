/**
 * Two "tenants" running the same vendor console (CoreServ) with different
 * branding, labels and one extra step. This is the stand-in for the real
 * world where hundreds of institutions run the same core vendor product.
 */
export interface TenantConfig {
  id: string;
  name: string;
  shortName: string;
  color: string;
  /** Label used for the member lookup field. Harbor says "Member Number", Summit says "Account #". */
  memberLookupLabel: string;
  /** Summit shows a compliance reminder interstitial after login that must be acknowledged. */
  complianceInterstitialAfterLogin: boolean;
  /** Vendor console version string shown in the footer. */
  consoleVersion: string;
}

export const TENANTS: Record<string, TenantConfig> = {
  harbor: {
    id: 'harbor',
    name: 'Harbor Federal Credit Union',
    shortName: 'HarborFCU',
    color: '#0b3d91',
    memberLookupLabel: 'Member Number',
    complianceInterstitialAfterLogin: false,
    consoleVersion: 'CoreServ 7.2.14',
  },
  summit: {
    id: 'summit',
    name: 'Summit Community Bank',
    shortName: 'SummitCB',
    color: '#2e6b2e',
    memberLookupLabel: 'Account #',
    complianceInterstitialAfterLogin: true,
    consoleVersion: 'CoreServ 7.3.02',
  },
};
