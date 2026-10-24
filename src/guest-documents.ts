// Guest-account GraphQL documents, copied verbatim from Toast's own guest web
// app (toast.app, build "capman-guest-app" 1200): its persisted-query map
// pairs each operation hash with the full document, fragments inlined. Field
// names here are therefore Toast's, not guesses — but only the ones listed.
// Every payload these tools parse was captured live 2026-10-24 and scrubbed
// into tests/fixtures/guest/.
//
// All six are queries. Do not add a document from that map without checking
// its keyword: the same map holds the app's mutations (refresh token, receipt
// PDF, booking changes), and `assertReadOnlyDocument` is run on these at
// module load (tests/guest-documents.test.ts) so an edit cannot slip one in.

export interface GuestOperation {
  /** The operation name, which the gateway logs and Toast's app sends. */
  name: string;
  document: string;
}

export const ORDER_HISTORY: GuestOperation = {
  name: "capmanGuestApp_GetGuestOrderHistory",
  document:
    "fragment OrderCardFragment on CompletedOrder { diningOptionBehavior guid numberOfSelections openedDateTime orderStatus restaurant { guid location { country } logoUrls { xs } name shortUrl timeZoneId whiteLabelName } selections { guid name quantity } totalV2 } query capmanGuestApp_GetGuestOrderHistory($input: OrderHistoryInput!) { orderHistory(input: $input) { nextPageToken orders { guid openedDateTime restaurant { timeZoneId } ...OrderCardFragment } } }",
};

export const COMPLETED_ORDER: GuestOperation = {
  name: "capmanGuestApp_GetCompletedOrder",
  document:
    "fragment OrderDetailFragment on CompletedOrder { appliedToastFundedOffers { amount { amount } offer { __typename } paymentGuid } checkGuid checkNumber deliveryInfo { address1 address2 city state zipCode } deliveryServiceCharges deliveryServiceInfo { providerName } diningOptionBehavior discounts { boostDiscount { amount } globalReward { amount } } discountsTotal fundraisingTotal giftCard { appliedBalance } gratuityServiceCharges guid nonDeliveryNonGratuityNonUbpServiceCharges openedDateTime orderStatus payments { amount cardType guid last4Digits otherPaymentName totalAmount type } preDiscountItemsSubtotal processingServiceCharges restaurant { guid location { country } logoUrls { xs } name shortUrl timeZoneId whiteLabelName } selections { guid modifiers { name } name price quantity } surchargeServiceCharges { baseAmount taxAmount } taxV2 tip totalV2 } query capmanGuestApp_GetCompletedOrder($input: CompletedOrderInput!) { completedOrder(input: $input) { guid ...OrderDetailFragment } }",
};

export const REWARDS: GuestOperation = {
  name: "capmanGuestApp_GetGuestRewards",
  document:
    "fragment RewardsCountFragment on GuestRestaurantLoyaltyInfoResponse { rewards { available } } fragment RewardsProgramCardFragment on GuestRestaurantLoyaltyInfoResponse { balances { balance type } loyaltyAccountGuid programName restaurant { guid logoUrls { xs } loyaltyFeatures { restaurantsInLoyaltySet { guid location { address1 city state } name onlineOrderingEnabled shortUrl } } name onlineOrderingEnabled shortUrl } rewards { available leftToTarget rewardMessages { nextRewardMessage rewardLabelMessage rewardValueMessage unlockedMessage } tags target } } query capmanGuestApp_GetGuestRewards { guest { allLoyaltyAccountInfos { loyaltyAccountGuid ...RewardsCountFragment ...RewardsProgramCardFragment } id } }",
};

export const WALLET: GuestOperation = {
  name: "capmanGuestApp_GetGuestWallet",
  document:
    "fragment ToastCashFragment on GuestCurrencyAccount { availableBalanceWithStoredValue { amount currency } nearestFutureExpirableDayValue(timeZone: $timeZone) { amount { amount currency } expirationDate } } query capmanGuestApp_GetGuestWallet($timeZone: String!) { guest { id wallet { guestCurrencyAccount { id ...ToastCashFragment } id } } }",
};

export const EXPIRABLE_UNITS: GuestOperation = {
  name: "capmanGuestApp_GetGuestCurrencyExpirableUnits",
  document:
    "fragment ExpiringUnitRowFragment on GuestCurrencyExpirableUnit { availableBalance { amount currency } expirationDateTime issuanceReason } query capmanGuestApp_GetGuestCurrencyExpirableUnits($pageInput: PageInput) { guest { id wallet { guestCurrencyAccount { expirableUnits(pageInput: $pageInput) { items { expirationDateTime id ...ExpiringUnitRowFragment } nextPageToken } id } id } } }",
};

export const RECEIVED_UNITS: GuestOperation = {
  name: "capmanGuestApp_GetGuestCurrencyReceivedUnits",
  document:
    "fragment ReceivedUnitRowFragment on GuestCurrencyUnit { __typename issuanceReason issuedAmount { amount currency } issuedDateTime ... on GuestCurrencyStoredValueGiftUnit { giftDetails { senderName } } } query capmanGuestApp_GetGuestCurrencyReceivedUnits { guest { id wallet { guestCurrencyAccount { id receivedUnits { items { __typename id ...ReceivedUnitRowFragment } } } id } } }",
};
