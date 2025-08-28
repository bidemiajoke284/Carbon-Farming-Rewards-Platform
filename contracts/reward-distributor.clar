;; RewardDistributor.clar
;; Core contract for distributing CarbonTokens (CT) based on verified soil health improvements.
;; Integrates with SoilMetrics for data, OracleVerifier for validation, CarbonToken for minting,
;; and GovernanceDAO for adjustable parameters.

;; Traits
(use-trait carbon-token-trait .carbon-token-trait.carbon-token-trait)
(use-trait soil-metrics-trait .soil-metrics-trait.soil-metrics-trait)
(use-trait oracle-verifier-trait .oracle-verifier-trait.oracle-verifier-trait)
(use-trait governance-dao-trait .governance-dao-trait.governance-dao-trait)

;; Constants
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-INVALID-FARM (err u101))
(define-constant ERR-UNVERIFIED-DATA (err u102))
(define-constant ERR-INSUFFICIENT-SEQUESTERED (err u103))
(define-constant ERR-REWARD-ALREADY-CLAIMED (err u104))
(define-constant ERR-INVALID-PARAMETER (err u105))
(define-constant ERR-PAUSED (err u106))
(define-constant ERR-CALCULATION-OVERFLOW (err u107))
(define-constant ERR-DAO-NOT-SET (err u108))
(define-constant ERR-TOKEN-NOT-SET (err u109))
(define-constant ERR-METRICS-NOT-SET (err u110))
(define-constant ERR-VERIFIER-NOT-SET (err u111))
(define-constant ERR-INVALID-PERIOD (err u112))
(define-constant ERR-COOLDOWN-NOT-MET (err u113))

(define-constant BASE-REWARD-RATE u1000000) ;; 1 CT per ton CO2, scaled by 1e6 for precision
(define-constant MIN-SEQUESTERED u1000000) ;; Minimum 1 ton CO2 equivalent (scaled)
(define-constant CLAIM-COOLDOWN u144) ;; ~1 day in blocks

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var is-paused bool false)
(define-data-var carbon-token-contract principal 'SP000000000000000000002Q6VF78.carbon-token) ;; Placeholder
(define-data-var soil-metrics-contract principal 'SP000000000000000000002Q6VF78.soil-metrics) ;; Placeholder
(define-data-var oracle-verifier-contract principal 'SP000000000000000000002Q6VF78.oracle-verifier) ;; Placeholder
(define-data-var governance-dao-contract principal 'SP000000000000000000002Q6VF78.governance-dao) ;; Placeholder
(define-data-var reward-multiplier uint u1000000) ;; 1x base, adjustable via DAO
(define-data-var total-rewards-distributed uint u0)
(define-data-var emission-reduction-factor uint u900000) ;; 0.9 factor for conservative estimates

;; Data Maps
(define-map farm-reward-claims
  { farm-id: uint, period: uint }
  {
    claimed: bool,
    sequestered-amount: uint,
    reward-amount: uint,
    claim-time: uint
  }
)

(define-map farm-last-claim
  { farm-id: uint }
  { last-period: uint, last-block: uint }
)

;; Private Functions
(define-private (is-contract-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (calculate-reward (sequestered uint))
  (let
    (
      (base (* sequestered BASE-REWARD-RATE))
      (multiplied (/ (* base (var-get reward-multiplier)) u1000000))
      (adjusted (/ (* multiplied (var-get emission-reduction-factor)) u1000000))
    )
    (if (> adjusted u0)
      (ok adjusted)
      ERR-CALCULATION-OVERFLOW)
  )
)

(define-private (validate-sequestered (sequestered uint))
  (if (>= sequestered MIN-SEQUESTERED)
    (ok true)
    ERR-INSUFFICIENT-SEQUESTERED)
)

(define-private (check-cooldown (farm-id uint) (current-block uint))
  (match (map-get? farm-last-claim {farm-id: farm-id})
    last-claim
    (if (>= (- current-block (get last-block last-claim)) CLAIM-COOLDOWN)
      (ok true)
      ERR-COOLDOWN-NOT-MET)
    (ok true)
  )
)

;; Public Functions
(define-public (set-carbon-token-contract (new-contract principal))
  (if (is-contract-owner tx-sender)
    (ok (var-set carbon-token-contract new-contract))
    ERR-UNAUTHORIZED)
)

(define-public (set-soil-metrics-contract (new-contract principal))
  (if (is-contract-owner tx-sender)
    (ok (var-set soil-metrics-contract new-contract))
    ERR-UNAUTHORIZED)
)

(define-public (set-oracle-verifier-contract (new-contract principal))
  (if (is-contract-owner tx-sender)
    (ok (var-set oracle-verifier-contract new-contract))
    ERR-UNAUTHORIZED)
)

(define-public (set-governance-dao-contract (new-contract principal))
  (if (is-contract-owner tx-sender)
    (ok (var-set governance-dao-contract new-contract))
    ERR-UNAUTHORIZED)
)

(define-public (pause-contract)
  (if (is-contract-owner tx-sender)
    (ok (var-set is-paused true))
    ERR-UNAUTHORIZED)
)

(define-public (unpause-contract)
  (if (is-contract-owner tx-sender)
    (ok (var-set is-paused false))
    ERR-UNAUTHORIZED)
)

(define-public (update-reward-multiplier (new-multiplier uint))
  (let
    (
      (dao (as-contract (contract-call? .governance-dao-trait get-dao-address)))
    )
    (if (or (is-contract-owner tx-sender) (is-eq tx-sender dao))
      (if (and (> new-multiplier u0) (<= new-multiplier u5000000)) ;; Max 5x
        (ok (var-set reward-multiplier new-multiplier))
        ERR-INVALID-PARAMETER)
      ERR-UNAUTHORIZED)
  )
)

(define-public (update-emission-factor (new-factor uint))
  (let
    (
      (dao (as-contract (contract-call? .governance-dao-trait get-dao-address)))
    )
    (if (or (is-contract-owner tx-sender) (is-eq tx-sender dao))
      (if (and (>= new-factor u500000) (<= new-factor u1000000)) ;; 0.5 to 1.0
        (ok (var-set emission-reduction-factor new-factor))
        ERR-INVALID-PARAMETER)
      ERR-UNAUTHORIZED)
  )
)

(define-public (claim-reward (farm-id uint) (period uint))
  (let
    (
      (current-block block-height)
      (metrics-contract (var-get soil-metrics-contract))
      (verifier-contract (var-get oracle-verifier-contract))
      (token-contract (var-get carbon-token-contract))
      (sequestered (as-contract (contract-call? .soil-metrics-trait get-sequestered-amount farm-id period)))
      (is-verified (as-contract (contract-call? .oracle-verifier-trait is-data-verified farm-id period)))
      (claim-entry (map-get? farm-reward-claims {farm-id: farm-id, period: period}))
    )
    (if (var-get is-paused)
      ERR-PAUSED
      (if (is-none (as-contract (contract-call? .soil-metrics-trait get-farm-owner farm-id)))
        ERR-INVALID-FARM
        (if (not (is-eq tx-sender (as-contract (contract-call? .soil-metrics-trait get-farm-owner farm-id))))
          ERR-UNAUTHORIZED
          (if (not is-verified)
            ERR-UNVERIFIED-DATA
            (try! (validate-sequestered sequestered))
            (try! (check-cooldown farm-id current-block))
            (if (and (is-some claim-entry) (get claimed (unwrap-panic claim-entry)))
              ERR-REWARD-ALREADY-CLAIMED
              (let
                (
                  (reward (try! (calculate-reward sequestered)))
                )
                (map-set farm-reward-claims
                  {farm-id: farm-id, period: period}
                  {
                    claimed: true,
                    sequestered-amount: sequestered,
                    reward-amount: reward,
                    claim-time: current-block
                  }
                )
                (map-set farm-last-claim
                  {farm-id: farm-id}
                  {last-period: period, last-block: current-block}
                )
                (var-set total-rewards-distributed (+ (var-get total-rewards-distributed) reward))
                (as-contract (contract-call? .carbon-token-trait mint tx-sender reward))
              )
            )
          )
        )
      )
    )
  )
)

;; Read-Only Functions
(define-read-only (get-reward-claim (farm-id uint) (period uint))
  (map-get? farm-reward-claims {farm-id: farm-id, period: period})
)

(define-read-only (get-last-claim (farm-id uint))
  (map-get? farm-last-claim {farm-id: farm-id})
)

(define-read-only (get-total-rewards-distributed)
  (var-get total-rewards-distributed)
)

(define-read-only (get-current-multiplier)
  (var-get reward-multiplier)
)

(define-read-only (get-current-emission-factor)
  (var-get emission-reduction-factor)
)

(define-read-only (is-contract-paused)
  (var-get is-paused)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)

(define-read-only (estimate-reward (sequestered uint))
  (calculate-reward sequestered)
)

;; Additional sophisticated features: Batch claims for multiple periods
(define-public (batch-claim-rewards (farm-id uint) (periods (list 10 uint)))
  (fold batch-claim-iter periods (ok u0))
)

(define-private (batch-claim-iter (period uint) (prev (response uint uint)))
  (match prev
    total
    (let
      (
        (claim-result (claim-reward farm-id period))
      )
      (match claim-result
        success (+ total (get reward-amount success))
        err err
      )
    )
    err err
  )
)

;; Event emission simulation (Clarity doesn't have native events, but we can use print for logging)
(define-private (log-event (event-type (string-ascii 32)) (data (buff 128)))
  (print {event: event-type, data: data})
)