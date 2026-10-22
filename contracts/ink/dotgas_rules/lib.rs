#![cfg_attr(not(feature = "std"), no_std, no_main)]

//! # DotGas rules (WASM half)
//!
//! Policy engine + audit ledger for DotGas, deployed on Portaldot's `pallet-contracts`.
//! Before the relayer pays out tPOT from `DotGasDock` (EVM, pallet-revive) it must get an
//! approval recorded here. The contract enforces:
//!
//! * a global daily budget (UTC days derived from the block timestamp),
//! * a lifetime cap per recipient (EVM H160 address),
//! * a cooldown in blocks between two approvals for the same recipient,
//! * a pause switch,
//! * one approval per order id (duplicates are rejected).
//!
//! Every approval is stored with its block number so the ledger can be audited on-chain.
//! Amounts are native tPOT units (14 decimals), not the 18-decimal EVM-side unit.
//!
//! There is no direct call between the WASM and EVM contracts in the runtime: the relayer
//! calls `approve` here first and only then calls `DotGasDock.fill`.

#[ink::contract]
mod dotgas_rules {
    use ink::storage::Mapping;

    pub type OrderId = [u8; 32];
    pub type EvmAddress = [u8; 20];

    /// Milliseconds per day; `pallet-timestamp` reports milliseconds.
    pub const DAY_MS: u64 = 86_400_000;

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub enum Error {
        NotOwner,
        NotRelayer,
        Paused,
        AlreadyApproved,
        ZeroAmount,
        ZeroRecipient,
        DailyBudgetExceeded,
        RecipientCapExceeded,
        CooldownActive,
        Overflow,
        ZeroAccount,
        NotPendingOwner,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct Approval {
        pub recipient: EvmAddress,
        pub amount: Balance,
        pub block: BlockNumber,
        pub timestamp: Timestamp,
    }

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub struct Stats {
        pub approvals: u64,
        pub total_approved: Balance,
        pub day: u64,
        pub spent_today: Balance,
        pub remaining_today: Balance,
        pub daily_budget: Balance,
        pub recipient_cap: Balance,
        pub cooldown_blocks: BlockNumber,
        pub paused: bool,
    }

    #[ink(event)]
    pub struct Approved {
        #[ink(topic)]
        order_id: OrderId,
        #[ink(topic)]
        recipient: EvmAddress,
        amount: Balance,
        block: BlockNumber,
    }

    #[ink(event)]
    pub struct ConfigUpdated {
        daily_budget: Balance,
        recipient_cap: Balance,
        cooldown_blocks: BlockNumber,
    }

    #[ink(event)]
    pub struct PausedSet {
        paused: bool,
    }

    #[ink(event)]
    pub struct RelayerUpdated {
        #[ink(topic)]
        relayer: AccountId,
    }

    #[ink(event)]
    pub struct OwnershipTransferStarted {
        #[ink(topic)]
        pending_owner: AccountId,
    }

    #[ink(event)]
    pub struct OwnershipTransferred {
        #[ink(topic)]
        new_owner: AccountId,
    }

    #[ink(storage)]
    pub struct DotGasRules {
        owner: AccountId,
        pending_owner: Option<AccountId>,
        relayer: AccountId,
        paused: bool,
        daily_budget: Balance,
        recipient_cap: Balance,
        cooldown_blocks: BlockNumber,
        day: u64,
        spent_today: Balance,
        approvals: Mapping<OrderId, Approval>,
        received: Mapping<EvmAddress, Balance>,
        last_approval_block: Mapping<EvmAddress, BlockNumber>,
        approval_count: u64,
        total_approved: Balance,
    }

    impl DotGasRules {
        /// The caller becomes the owner.
        #[ink(constructor)]
        pub fn new(
            relayer: AccountId,
            daily_budget: Balance,
            recipient_cap: Balance,
            cooldown_blocks: BlockNumber,
        ) -> Self {
            Self {
                owner: Self::env().caller(),
                pending_owner: None,
                relayer,
                paused: false,
                daily_budget,
                recipient_cap,
                cooldown_blocks,
                day: Self::env().block_timestamp() / DAY_MS,
                spent_today: 0,
                approvals: Mapping::default(),
                received: Mapping::default(),
                last_approval_block: Mapping::default(),
                approval_count: 0,
                total_approved: 0,
            }
        }

        // ------------------------------------------------------------ relayer

        /// Record an approval for `order_id` paying `amount` (native units) to `recipient`.
        /// Only the relayer may call this; every policy check must pass or nothing is stored.
        #[ink(message)]
        pub fn approve(
            &mut self,
            order_id: OrderId,
            recipient: EvmAddress,
            amount: Balance,
        ) -> Result<()> {
            if self.env().caller() != self.relayer {
                return Err(Error::NotRelayer);
            }
            if self.paused {
                return Err(Error::Paused);
            }
            if amount == 0 {
                return Err(Error::ZeroAmount);
            }
            if recipient == [0u8; 20] {
                return Err(Error::ZeroRecipient);
            }
            if self.approvals.contains(order_id) {
                return Err(Error::AlreadyApproved);
            }

            let block = self.env().block_number();
            if let Some(last) = self.last_approval_block.get(recipient) {
                if block < last.saturating_add(self.cooldown_blocks) {
                    return Err(Error::CooldownActive);
                }
            }

            let received = self
                .received
                .get(recipient)
                .unwrap_or(0)
                .checked_add(amount)
                .ok_or(Error::Overflow)?;
            if received > self.recipient_cap {
                return Err(Error::RecipientCapExceeded);
            }

            let now = self.env().block_timestamp();
            let today = now / DAY_MS;
            let spent = if today == self.day {
                self.spent_today
            } else {
                0
            };
            let spent = spent.checked_add(amount).ok_or(Error::Overflow)?;
            if spent > self.daily_budget {
                return Err(Error::DailyBudgetExceeded);
            }

            self.day = today;
            self.spent_today = spent;
            self.received.insert(recipient, &received);
            self.last_approval_block.insert(recipient, &block);
            self.approvals.insert(
                order_id,
                &Approval {
                    recipient,
                    amount,
                    block,
                    timestamp: now,
                },
            );
            self.approval_count = self.approval_count.saturating_add(1);
            self.total_approved = self.total_approved.saturating_add(amount);
            self.env().emit_event(Approved {
                order_id,
                recipient,
                amount,
                block,
            });
            Ok(())
        }

        // ------------------------------------------------------------ queries

        #[ink(message)]
        pub fn is_approved(&self, order_id: OrderId) -> bool {
            self.approvals.contains(order_id)
        }

        #[ink(message)]
        pub fn approval(&self, order_id: OrderId) -> Option<Approval> {
            self.approvals.get(order_id)
        }

        #[ink(message)]
        pub fn remaining_today(&self) -> Balance {
            self.daily_budget
                .saturating_sub(self.spent_on_current_day())
        }

        #[ink(message)]
        pub fn received_by(&self, recipient: EvmAddress) -> Balance {
            self.received.get(recipient).unwrap_or(0)
        }

        #[ink(message)]
        pub fn stats(&self) -> Stats {
            Stats {
                approvals: self.approval_count,
                total_approved: self.total_approved,
                day: self.env().block_timestamp() / DAY_MS,
                spent_today: self.spent_on_current_day(),
                remaining_today: self.remaining_today(),
                daily_budget: self.daily_budget,
                recipient_cap: self.recipient_cap,
                cooldown_blocks: self.cooldown_blocks,
                paused: self.paused,
            }
        }

        #[ink(message)]
        pub fn owner(&self) -> AccountId {
            self.owner
        }

        #[ink(message)]
        pub fn pending_owner(&self) -> Option<AccountId> {
            self.pending_owner
        }

        #[ink(message)]
        pub fn relayer(&self) -> AccountId {
            self.relayer
        }

        // ------------------------------------------------------------ owner

        #[ink(message)]
        pub fn set_relayer(&mut self, relayer: AccountId) -> Result<()> {
            self.ensure_owner()?;
            Self::ensure_nonzero(&relayer)?;
            self.relayer = relayer;
            self.env().emit_event(RelayerUpdated { relayer });
            Ok(())
        }

        #[ink(message)]
        pub fn set_limits(
            &mut self,
            daily_budget: Balance,
            recipient_cap: Balance,
            cooldown_blocks: BlockNumber,
        ) -> Result<()> {
            self.ensure_owner()?;
            self.daily_budget = daily_budget;
            self.recipient_cap = recipient_cap;
            self.cooldown_blocks = cooldown_blocks;
            self.env().emit_event(ConfigUpdated {
                daily_budget,
                recipient_cap,
                cooldown_blocks,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn set_paused(&mut self, paused: bool) -> Result<()> {
            self.ensure_owner()?;
            self.paused = paused;
            self.env().emit_event(PausedSet { paused });
            Ok(())
        }

        /// Step 1 of 2: nominate `new_owner`. Ownership only moves once the nominee calls
        /// `accept_ownership`, so a typo cannot lock the contract. A new nomination replaces the old one.
        #[ink(message)]
        pub fn transfer_ownership(&mut self, new_owner: AccountId) -> Result<()> {
            self.ensure_owner()?;
            Self::ensure_nonzero(&new_owner)?;
            self.pending_owner = Some(new_owner);
            self.env().emit_event(OwnershipTransferStarted {
                pending_owner: new_owner,
            });
            Ok(())
        }

        /// Step 2 of 2: the nominated account takes ownership.
        #[ink(message)]
        pub fn accept_ownership(&mut self) -> Result<()> {
            let caller = self.env().caller();
            if self.pending_owner != Some(caller) {
                return Err(Error::NotPendingOwner);
            }
            self.owner = caller;
            self.pending_owner = None;
            self.env().emit_event(OwnershipTransferred { new_owner: caller });
            Ok(())
        }

        // ------------------------------------------------------------ internal

        fn ensure_owner(&self) -> Result<()> {
            if self.env().caller() != self.owner {
                return Err(Error::NotOwner);
            }
            Ok(())
        }

        fn ensure_nonzero(account: &AccountId) -> Result<()> {
            if *account == AccountId::from([0u8; 32]) {
                return Err(Error::ZeroAccount);
            }
            Ok(())
        }

        fn spent_on_current_day(&self) -> Balance {
            if self.env().block_timestamp() / DAY_MS == self.day {
                self.spent_today
            } else {
                0
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use ink::env::{test, DefaultEnvironment as Env};

        const UNIT: Balance = 100_000_000_000_000; // 1 tPOT, 14 decimals
        const BUDGET: Balance = 100 * UNIT;
        const CAP: Balance = 30 * UNIT;
        const COOLDOWN: BlockNumber = 3;

        fn accounts() -> test::DefaultAccounts<Env> {
            test::default_accounts::<Env>()
        }

        /// Owner = alice, relayer = bob. Caller is left as bob.
        fn setup() -> DotGasRules {
            let a = accounts();
            test::set_caller::<Env>(a.alice);
            test::set_block_timestamp::<Env>(1_700_000_000_000);
            let c = DotGasRules::new(a.bob, BUDGET, CAP, COOLDOWN);
            test::set_caller::<Env>(a.bob);
            c
        }

        fn oid(n: u8) -> OrderId {
            [n; 32]
        }

        fn addr(n: u8) -> EvmAddress {
            [n; 20]
        }

        fn advance(blocks: u32) {
            for _ in 0..blocks {
                test::advance_block::<Env>();
            }
        }

        #[ink::test]
        fn constructor_sets_config() {
            let c = setup();
            let a = accounts();
            assert_eq!(c.owner(), a.alice);
            assert_eq!(c.relayer(), a.bob);
            let s = c.stats();
            assert_eq!(s.daily_budget, BUDGET);
            assert_eq!(s.recipient_cap, CAP);
            assert_eq!(s.cooldown_blocks, COOLDOWN);
            assert_eq!(s.approvals, 0);
            assert!(!s.paused);
            assert_eq!(c.remaining_today(), BUDGET);
        }

        #[ink::test]
        fn approve_happy_path_records_ledger() {
            let mut c = setup();
            advance(5);
            let now = ink::env::block_timestamp::<Env>();
            assert_eq!(c.approve(oid(1), addr(7), 5 * UNIT), Ok(()));
            assert!(c.is_approved(oid(1)));
            assert!(!c.is_approved(oid(2)));
            let ap = c.approval(oid(1)).expect("stored");
            assert_eq!(ap.recipient, addr(7));
            assert_eq!(ap.amount, 5 * UNIT);
            assert_eq!(ap.block, 5);
            assert_eq!(ap.timestamp, now);
            assert_eq!(c.received_by(addr(7)), 5 * UNIT);
            assert_eq!(c.remaining_today(), BUDGET - 5 * UNIT);
            let s = c.stats();
            assert_eq!(s.approvals, 1);
            assert_eq!(s.total_approved, 5 * UNIT);
            assert_eq!(s.spent_today, 5 * UNIT);
            assert_eq!(test::recorded_events().count(), 1);
        }

        #[ink::test]
        fn only_relayer_can_approve() {
            let mut c = setup();
            test::set_caller::<Env>(accounts().alice); // owner is not the relayer
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Err(Error::NotRelayer));
            test::set_caller::<Env>(accounts().charlie);
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Err(Error::NotRelayer));
            assert!(!c.is_approved(oid(1)));
        }

        #[ink::test]
        fn duplicate_order_rejected() {
            let mut c = setup();
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Ok(()));
            advance(10);
            assert_eq!(
                c.approve(oid(1), addr(2), UNIT),
                Err(Error::AlreadyApproved)
            );
            assert_eq!(c.stats().approvals, 1);
        }

        #[ink::test]
        fn zero_amount_and_recipient_rejected() {
            let mut c = setup();
            assert_eq!(c.approve(oid(1), addr(1), 0), Err(Error::ZeroAmount));
            assert_eq!(
                c.approve(oid(1), [0u8; 20], UNIT),
                Err(Error::ZeroRecipient)
            );
        }

        #[ink::test]
        fn cooldown_per_recipient() {
            let mut c = setup();
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Ok(()));
            advance(COOLDOWN - 1);
            assert_eq!(c.approve(oid(2), addr(1), UNIT), Err(Error::CooldownActive));
            // a different recipient is not affected
            assert_eq!(c.approve(oid(3), addr(2), UNIT), Ok(()));
            advance(1);
            assert_eq!(c.approve(oid(2), addr(1), UNIT), Ok(()));
        }

        #[ink::test]
        fn recipient_cap_is_lifetime() {
            let mut c = setup();
            assert_eq!(c.approve(oid(1), addr(1), 20 * UNIT), Ok(()));
            advance(COOLDOWN);
            assert_eq!(c.approve(oid(2), addr(1), 10 * UNIT), Ok(())); // exactly at cap
            advance(COOLDOWN);
            assert_eq!(
                c.approve(oid(3), addr(1), 1),
                Err(Error::RecipientCapExceeded)
            );
            // a new day does not reset the lifetime cap
            test::set_block_timestamp::<Env>(1_700_000_000_000 + 2 * DAY_MS);
            assert_eq!(
                c.approve(oid(3), addr(1), 1),
                Err(Error::RecipientCapExceeded)
            );
            assert_eq!(c.received_by(addr(1)), CAP);
        }

        #[ink::test]
        fn daily_budget_enforced_and_resets() {
            let mut c = setup();
            for i in 0..4u8 {
                assert_eq!(c.approve(oid(i), addr(i + 1), 25 * UNIT), Ok(()));
            }
            assert_eq!(c.remaining_today(), 0);
            assert_eq!(
                c.approve(oid(10), addr(50), 1),
                Err(Error::DailyBudgetExceeded)
            );
            // next UTC day
            test::set_block_timestamp::<Env>(1_700_000_000_000 + DAY_MS);
            assert_eq!(c.remaining_today(), BUDGET);
            assert_eq!(c.stats().spent_today, 0);
            assert_eq!(c.approve(oid(10), addr(50), 25 * UNIT), Ok(()));
            assert_eq!(c.remaining_today(), BUDGET - 25 * UNIT);
            assert_eq!(c.stats().total_approved, 125 * UNIT);
        }

        #[ink::test]
        fn pause_blocks_approvals() {
            let mut c = setup();
            test::set_caller::<Env>(accounts().alice);
            assert_eq!(c.set_paused(true), Ok(()));
            assert!(c.stats().paused);
            test::set_caller::<Env>(accounts().bob);
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Err(Error::Paused));
            test::set_caller::<Env>(accounts().alice);
            assert_eq!(c.set_paused(false), Ok(()));
            test::set_caller::<Env>(accounts().bob);
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Ok(()));
        }

        #[ink::test]
        fn failed_approval_changes_nothing() {
            let mut c = setup();
            assert_eq!(
                c.approve(oid(1), addr(1), 31 * UNIT),
                Err(Error::RecipientCapExceeded)
            );
            assert!(!c.is_approved(oid(1)));
            assert_eq!(c.received_by(addr(1)), 0);
            assert_eq!(c.remaining_today(), BUDGET);
            // no cooldown was started by the failed attempt
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Ok(()));
        }

        #[ink::test]
        fn owner_setters_access_control() {
            let mut c = setup();
            let a = accounts();
            // bob (relayer) is not the owner
            assert_eq!(c.set_paused(true), Err(Error::NotOwner));
            assert_eq!(c.set_limits(1, 1, 1), Err(Error::NotOwner));
            assert_eq!(c.set_relayer(a.bob), Err(Error::NotOwner));
            assert_eq!(c.transfer_ownership(a.bob), Err(Error::NotOwner));

            test::set_caller::<Env>(a.alice);
            assert_eq!(c.set_limits(10 * UNIT, 5 * UNIT, 0), Ok(()));
            let s = c.stats();
            assert_eq!(
                (s.daily_budget, s.recipient_cap, s.cooldown_blocks),
                (10 * UNIT, 5 * UNIT, 0)
            );
            assert_eq!(c.set_relayer(a.charlie), Ok(()));
            assert_eq!(c.relayer(), a.charlie);

            // old relayer locked out, new relayer works
            test::set_caller::<Env>(a.bob);
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Err(Error::NotRelayer));
            test::set_caller::<Env>(a.charlie);
            assert_eq!(c.approve(oid(1), addr(1), UNIT), Ok(()));
            // cooldown 0 allows back-to-back approvals for the same recipient
            assert_eq!(c.approve(oid(2), addr(1), UNIT), Ok(()));

            test::set_caller::<Env>(a.alice);
            assert_eq!(c.transfer_ownership(a.django), Ok(()));
            test::set_caller::<Env>(a.django);
            assert_eq!(c.accept_ownership(), Ok(()));
            assert_eq!(c.owner(), a.django);
            test::set_caller::<Env>(a.alice);
            assert_eq!(c.set_paused(true), Err(Error::NotOwner));
        }

        #[ink::test]
        fn zero_account_rejected() {
            let mut c = setup();
            let a = accounts();
            let zero = AccountId::from([0u8; 32]);
            test::set_caller::<Env>(a.alice);
            assert_eq!(c.set_relayer(zero), Err(Error::ZeroAccount));
            assert_eq!(c.relayer(), a.bob);
            assert_eq!(c.transfer_ownership(zero), Err(Error::ZeroAccount));
            assert_eq!(c.pending_owner(), None);
            assert_eq!(c.owner(), a.alice);
        }

        #[ink::test]
        fn ownership_transfer_is_two_step() {
            let mut c = setup();
            let a = accounts();
            test::set_caller::<Env>(a.alice);
            assert_eq!(c.transfer_ownership(a.charlie), Ok(()));
            // nothing changes until the nominee accepts
            assert_eq!(c.owner(), a.alice);
            assert_eq!(c.pending_owner(), Some(a.charlie));
            assert_eq!(c.set_paused(true), Ok(()));

            // only the nominee can accept: not the owner, not anyone else
            assert_eq!(c.accept_ownership(), Err(Error::NotPendingOwner));
            test::set_caller::<Env>(a.django);
            assert_eq!(c.accept_ownership(), Err(Error::NotPendingOwner));
            test::set_caller::<Env>(a.charlie);
            assert_eq!(c.set_paused(false), Err(Error::NotOwner));

            // the owner may re-nominate; the earlier nominee loses the right to accept
            test::set_caller::<Env>(a.alice);
            assert_eq!(c.transfer_ownership(a.django), Ok(()));
            test::set_caller::<Env>(a.charlie);
            assert_eq!(c.accept_ownership(), Err(Error::NotPendingOwner));

            test::set_caller::<Env>(a.django);
            assert_eq!(c.accept_ownership(), Ok(()));
            assert_eq!(c.owner(), a.django);
            assert_eq!(c.pending_owner(), None);
            assert_eq!(c.set_paused(false), Ok(()));
            test::set_caller::<Env>(a.alice);
            assert_eq!(c.set_paused(true), Err(Error::NotOwner));
            // a second accept is not possible
            test::set_caller::<Env>(a.django);
            assert_eq!(c.accept_ownership(), Err(Error::NotPendingOwner));
        }

        #[ink::test]
        fn overflow_is_rejected() {
            let a = accounts();
            test::set_caller::<Env>(a.alice);
            let mut c = DotGasRules::new(a.bob, Balance::MAX, Balance::MAX, 0);
            test::set_caller::<Env>(a.bob);
            assert_eq!(c.approve(oid(1), addr(1), Balance::MAX), Ok(()));
            assert_eq!(c.approve(oid(2), addr(2), 1), Err(Error::Overflow));
        }
    }
}
