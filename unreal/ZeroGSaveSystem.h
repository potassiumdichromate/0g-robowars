#pragma once

#include "CoreMinimal.h"
#include "GameFramework/SaveGame.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "ZeroGSaveSystem.generated.h"

// ── Delegate declarations ──────────────────────────────────────────────────────

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(
    FOnAuthComplete,
    bool, bSuccess,
    const FString&, ErrorMessage
);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams(
    FOnSaveUploadComplete,
    bool, bSuccess,
    const FString&, RootHash,
    int32, Version,
    const FString&, ErrorMessage
);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(
    FOnSaveDownloadComplete,
    bool, bSuccess,
    int32, Version,
    const FString&, ErrorMessage
);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(
    FOnVerifyComplete,
    bool, bSuccess,
    const FString&, Verdict,
    const FString&, ErrorMessage
);

DECLARE_DYNAMIC_MULTICAST_DELEGATE_FiveParams(
    FOnComputeValidationComplete,
    bool, bAccepted,
    const FString&, Verdict,       // "CLEAN" | "SUSPICIOUS" | "REJECTED"
    float, Confidence,
    bool, bTeeVerified,
    const FString&, ErrorMessage
);

// ── Compute validation result (returned in upload response) ────────────────────
USTRUCT(BlueprintType)
struct FZeroGComputeResult
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly)
    bool bAccepted = false;

    UPROPERTY(BlueprintReadOnly)
    FString Verdict;           // "CLEAN" | "SUSPICIOUS" | "REJECTED" | ""

    UPROPERTY(BlueprintReadOnly)
    float Confidence = 0.f;

    UPROPERTY(BlueprintReadOnly)
    bool bTeeVerified = false;

    UPROPERTY(BlueprintReadOnly)
    FString ProviderAddress;

    UPROPERTY(BlueprintReadOnly)
    FString ComputeStatus;     // "skipped" | "pending" | "validated" | "rejected"
};

// ── Save metadata returned from /save/latest ───────────────────────────────────
USTRUCT(BlueprintType)
struct FZeroGSaveMetadata
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly)
    int32 Version = 0;

    UPROPERTY(BlueprintReadOnly)
    FString RootHash;

    UPROPERTY(BlueprintReadOnly)
    FString Checksum;

    UPROPERTY(BlueprintReadOnly)
    int64 FileSize = 0;

    UPROPERTY(BlueprintReadOnly)
    FString DAStatus;  // "pending" | "finalized" | "failed"

    UPROPERTY(BlueprintReadOnly)
    FString ComputeStatus;  // "skipped" | "pending" | "validated" | "rejected"

    UPROPERTY(BlueprintReadOnly)
    FString ComputeVerdict;

    UPROPERTY(BlueprintReadOnly)
    FString CreatedAt;
};

// ── Main save system component ─────────────────────────────────────────────────

UCLASS(ClassGroup=(Custom), meta=(BlueprintSpawnableComponent))
class ROBOWARS_API UZeroGSaveSystem : public UActorComponent
{
    GENERATED_BODY()

public:
    UZeroGSaveSystem();

    // ── Configuration (set in editor or via GameInstance) ──────────────────────

    /** Backend base URL, e.g. "https://api.robowars.io" */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="0G|Config")
    FString BackendURL = TEXT("http://localhost:3000");

    /** Local .sav file name (relative to FPaths::ProjectSavedDir()) */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="0G|Config")
    FString SaveSlotName = TEXT("RoboWarsSave.sav");

    // ── Events ─────────────────────────────────────────────────────────────────

    UPROPERTY(BlueprintAssignable, Category="0G|Events")
    FOnAuthComplete OnAuthComplete;

    UPROPERTY(BlueprintAssignable, Category="0G|Events")
    FOnSaveUploadComplete OnSaveUploadComplete;

    UPROPERTY(BlueprintAssignable, Category="0G|Events")
    FOnSaveDownloadComplete OnSaveDownloadComplete;

    UPROPERTY(BlueprintAssignable, Category="0G|Events")
    FOnVerifyComplete OnVerifyComplete;

    UPROPERTY(BlueprintAssignable, Category="0G|Events")
    FOnComputeValidationComplete OnComputeValidationComplete;

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Step 1: Request a nonce from the backend for the given wallet address.
     * The returned nonce message must be signed by the player's wallet.
     * After signing, call VerifySignature() with the signature.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Auth")
    void RequestNonce(const FString& WalletAddress);

    /**
     * Step 2: Submit the signed nonce to obtain a JWT session token.
     * On success, stores the token internally — all subsequent calls use it.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Auth")
    void VerifySignature(const FString& WalletAddress, const FString& Signature);

    /**
     * Upload the current local .sav file to 0G Storage.
     *
     * @param bRequestCompute  Set true to explicitly request 0G Compute validation.
     *                         Pass true on high-stakes saves (level complete, reward unlocks).
     *                         For routine autosaves, leave false — heuristics decide.
     *
     * Fires OnSaveUploadComplete when storage upload completes.
     * If compute was requested or auto-triggered, OnComputeValidationComplete fires too.
     * If compute returns REJECTED, the save is not stored — OnSaveUploadComplete fires
     * with bSuccess=false and the rejection reason.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Save")
    void UploadSave(bool bRequestCompute = false);

    /**
     * Fetch the latest save metadata (rootHash, version, daStatus).
     * Does NOT download the file — use DownloadAndApplySave() for that.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Save")
    void FetchLatestMetadata(FOnSaveDownloadComplete MetadataCallback);

    /**
     * Download the latest (or specific version) .sav from 0G Storage,
     * write it to the local slot, and signal ready-to-load.
     *
     * Call this at game startup BEFORE loading the save game object.
     * Binding: OnSaveDownloadComplete fires when the local file is ready.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Save")
    void DownloadAndApplySave(int32 Version = -1);

    /**
     * Request the backend to verify the given rootHash via DA + checksum.
     * Use before accepting ranked scores or progression data from a client.
     */
    UFUNCTION(BlueprintCallable, Category="0G|AntiCheat")
    void VerifySave(const FString& RootHash);

    /** Returns the local path of the .sav file. */
    UFUNCTION(BlueprintPure, Category="0G|Save")
    FString GetLocalSavePath() const;

    /** True if the system holds a valid JWT. */
    UFUNCTION(BlueprintPure, Category="0G|Auth")
    bool IsAuthenticated() const { return !AuthToken.IsEmpty(); }

    /** Cached latest save metadata after FetchLatestMetadata(). */
    UPROPERTY(BlueprintReadOnly, Category="0G|Save")
    FZeroGSaveMetadata CachedMetadata;

    /** Cached result of the most recent compute validation. */
    UPROPERTY(BlueprintReadOnly, Category="0G|Compute")
    FZeroGComputeResult CachedComputeResult;

    /**
     * Manually trigger compute validation on an already-uploaded save.
     * Useful for re-validating before submitting a leaderboard score.
     */
    UFUNCTION(BlueprintCallable, Category="0G|Compute")
    void TriggerComputeValidation(const FString& RootHash);

private:
    FString AuthToken;
    FString PendingWalletAddress;
    bool bPendingComputeRequest = false;

    // ── HTTP helpers ───────────────────────────────────────────────────────────

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> MakeRequest(
        const FString& Verb,
        const FString& Endpoint,
        bool bRequiresAuth = true
    ) const;

    void SetJsonBody(
        TSharedRef<IHttpRequest, ESPMode::ThreadSafe>& Request,
        const TMap<FString, FString>& Fields
    ) const;

    // ── Response handlers ──────────────────────────────────────────────────────

    void OnNonceResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected
    );

    void OnVerifySignatureResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected
    );

    void OnUploadResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected
    );

    void OnDownloadMetadataResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected,
        int32 RequestedVersion
    );

    void OnDownloadBinaryResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected,
        int32 Version
    );

    void OnVerifyResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected
    );

    void OnComputeValidationResponse(
        FHttpRequestPtr Request,
        FHttpResponsePtr Response,
        bool bConnected
    );

    // ── Internals ─────────────────────────────────────────────────────────────
    bool WriteResponseToSavSlot(FHttpResponsePtr Response) const;
    FString ComputeSHA256(const TArray<uint8>& Data) const;
};
