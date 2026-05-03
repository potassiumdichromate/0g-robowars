#include "ZeroGSaveSystem.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "GenericPlatform/GenericPlatformHttp.h"

// ── Constructor ─────────────────────────────────────────────────────────────────
UZeroGSaveSystem::UZeroGSaveSystem()
{
    PrimaryComponentTick.bCanEverTick = false;
}

// ── Public API ──────────────────────────────────────────────────────────────────

void UZeroGSaveSystem::RequestNonce(const FString& WalletAddress)
{
    PendingWalletAddress = WalletAddress;

    auto Request = MakeRequest(TEXT("POST"), TEXT("/auth/nonce"), false);
    TMap<FString, FString> Body;
    Body.Add(TEXT("walletAddress"), WalletAddress);
    SetJsonBody(Request, Body);

    Request->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnNonceResponse
    );
    Request->ProcessRequest();
}

void UZeroGSaveSystem::VerifySignature(const FString& WalletAddress, const FString& Signature)
{
    auto Request = MakeRequest(TEXT("POST"), TEXT("/auth/verify"), false);

    TMap<FString, FString> Body;
    Body.Add(TEXT("walletAddress"), WalletAddress);
    Body.Add(TEXT("signature"), Signature);
    SetJsonBody(Request, Body);

    Request->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnVerifySignatureResponse
    );
    Request->ProcessRequest();
}

void UZeroGSaveSystem::UploadSave(bool bRequestCompute)
{
    if (!IsAuthenticated())
    {
        OnSaveUploadComplete.Broadcast(false, TEXT(""), -1, TEXT("Not authenticated"));
        return;
    }

    const FString SavePath = GetLocalSavePath();
    TArray<uint8> FileData;

    if (!FFileHelper::LoadFileToArray(FileData, *SavePath))
    {
        OnSaveUploadComplete.Broadcast(
            false, TEXT(""), -1,
            FString::Printf(TEXT("Cannot read save file: %s"), *SavePath)
        );
        return;
    }

    // ── Build multipart/form-data body ─────────────────────────────────────────
    // Unreal's HTTP module supports multipart via raw content + boundary header.
    const FString Boundary = TEXT("----ZeroGBoundary7MA4YWxkTrZu0gW");
    const FString CRLF     = TEXT("\r\n");

    // Store for use in response handler
    bPendingComputeRequest = bRequestCompute;

    // Build the header part as UTF-8
    FString HeaderPart;
    HeaderPart += TEXT("--") + Boundary + CRLF;
    HeaderPart += TEXT("Content-Disposition: form-data; name=\"savefile\"; filename=\"save.sav\"") + CRLF;
    HeaderPart += TEXT("Content-Type: application/octet-stream") + CRLF + CRLF;

    // Build footer
    FString FooterPart;
    FooterPart += CRLF + TEXT("--") + Boundary + TEXT("--") + CRLF;

    TArray<uint8> HeaderBytes;
    FTCHARToUTF8 HeaderConv(*HeaderPart);
    HeaderBytes.Append(reinterpret_cast<const uint8*>(HeaderConv.Get()), HeaderConv.Length());

    TArray<uint8> FooterBytes;
    FTCHARToUTF8 FooterConv(*FooterPart);
    FooterBytes.Append(reinterpret_cast<const uint8*>(FooterConv.Get()), FooterConv.Length());

    TArray<uint8> Body;
    Body.Append(HeaderBytes);
    Body.Append(FileData);
    Body.Append(FooterBytes);

    // ── Create HTTP request ────────────────────────────────────────────────────
    auto Request = MakeRequest(TEXT("POST"), TEXT("/save/upload"));
    Request->SetHeader(
        TEXT("Content-Type"),
        FString::Printf(TEXT("multipart/form-data; boundary=%s"), *Boundary)
    );
    // Signal backend to run 0G Compute validation on this upload.
    // Only send for high-stakes events (level complete, reward unlock).
    // Routine autosaves should omit this — heuristics on the backend decide.
    if (bRequestCompute)
    {
        Request->SetHeader(TEXT("X-Compute-Trigger"), TEXT("true"));
    }
    Request->SetContent(Body);

    Request->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnUploadResponse
    );
    Request->ProcessRequest();
}

void UZeroGSaveSystem::FetchLatestMetadata(FOnSaveDownloadComplete MetadataCallback)
{
    // Store callback — fire it after we parse the metadata response
    // (simplified: we use the DownloadAndApplySave path internally)
    DownloadAndApplySave(-1);
}

void UZeroGSaveSystem::DownloadAndApplySave(int32 Version)
{
    if (!IsAuthenticated())
    {
        OnSaveDownloadComplete.Broadcast(false, -1, TEXT("Not authenticated"));
        return;
    }

    // Step 1: Fetch latest save metadata to get rootHash + version
    FString Endpoint = TEXT("/save/latest");
    if (Version > 0)
    {
        Endpoint = FString::Printf(TEXT("/save/download?version=%d"), Version);
    }

    auto MetaRequest = MakeRequest(TEXT("GET"), Endpoint);
    MetaRequest->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnDownloadMetadataResponse,
        Version
    );
    MetaRequest->ProcessRequest();
}

void UZeroGSaveSystem::TriggerComputeValidation(const FString& RootHash)
{
    if (!IsAuthenticated())
    {
        OnComputeValidationComplete.Broadcast(
            false, TEXT("UNVERIFIED"), 0.f, false,
            TEXT("Not authenticated")
        );
        return;
    }

    // POST /save/verify — this endpoint runs the full 4-layer check including compute
    auto Request = MakeRequest(TEXT("POST"), TEXT("/save/verify"));
    TMap<FString, FString> Body;
    Body.Add(TEXT("rootHash"), RootHash);
    SetJsonBody(Request, Body);

    Request->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnComputeValidationResponse
    );
    Request->ProcessRequest();
}

void UZeroGSaveSystem::VerifySave(const FString& RootHash)
{
    if (!IsAuthenticated())
    {
        OnVerifyComplete.Broadcast(false, TEXT("UNVERIFIED"), TEXT("Not authenticated"));
        return;
    }

    auto Request = MakeRequest(TEXT("POST"), TEXT("/save/verify"));
    TMap<FString, FString> Body;
    Body.Add(TEXT("rootHash"), RootHash);
    SetJsonBody(Request, Body);

    Request->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnVerifyResponse
    );
    Request->ProcessRequest();
}

FString UZeroGSaveSystem::GetLocalSavePath() const
{
    return FPaths::Combine(FPaths::ProjectSavedDir(), SaveSlotName);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────────

TSharedRef<IHttpRequest, ESPMode::ThreadSafe> UZeroGSaveSystem::MakeRequest(
    const FString& Verb,
    const FString& Endpoint,
    bool bRequiresAuth
) const
{
    auto Request = FHttpModule::Get().CreateRequest();
    Request->SetVerb(Verb);
    Request->SetURL(BackendURL + Endpoint);
    Request->SetHeader(TEXT("Accept"), TEXT("application/json"));

    if (bRequiresAuth && !AuthToken.IsEmpty())
    {
        Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + AuthToken);
    }

    return Request;
}

void UZeroGSaveSystem::SetJsonBody(
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe>& Request,
    const TMap<FString, FString>& Fields
) const
{
    TSharedPtr<FJsonObject> JsonObj = MakeShareable(new FJsonObject());
    for (const auto& Pair : Fields)
    {
        JsonObj->SetStringField(Pair.Key, Pair.Value);
    }

    FString BodyStr;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&BodyStr);
    FJsonSerializer::Serialize(JsonObj.ToSharedRef(), Writer);

    Request->SetContentAsString(BodyStr);
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
}

// ── Response handlers ────────────────────────────────────────────────────────────

void UZeroGSaveSystem::OnNonceResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnAuthComplete.Broadcast(false, TEXT("Network error requesting nonce"));
        return;
    }

    if (Response->GetResponseCode() != 200)
    {
        OnAuthComplete.Broadcast(
            false,
            FString::Printf(TEXT("Nonce request failed (%d)"), Response->GetResponseCode())
        );
        return;
    }

    // Parse the message field — this is what the user's wallet must sign
    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnAuthComplete.Broadcast(false, TEXT("Failed to parse nonce response"));
        return;
    }

    FString Message;
    if (!Json->TryGetStringField(TEXT("message"), Message))
    {
        OnAuthComplete.Broadcast(false, TEXT("Nonce response missing 'message' field"));
        return;
    }

    // Signal Blueprint/GameMode — they handle the wallet signing flow
    // (MetaMask, WalletConnect, or a local key store)
    // The message is returned via the error param for now so BP can display it.
    OnAuthComplete.Broadcast(true, Message);
}

void UZeroGSaveSystem::OnVerifySignatureResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnAuthComplete.Broadcast(false, TEXT("Network error verifying signature"));
        return;
    }

    if (Response->GetResponseCode() != 200)
    {
        TSharedPtr<FJsonObject> Json;
        TSharedRef<TJsonReader<>> Reader =
            TJsonReaderFactory<>::Create(Response->GetContentAsString());
        FString ErrMsg = TEXT("Signature verification failed");
        if (FJsonSerializer::Deserialize(Reader, Json))
        {
            Json->TryGetStringField(TEXT("error"), ErrMsg);
        }
        OnAuthComplete.Broadcast(false, ErrMsg);
        return;
    }

    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnAuthComplete.Broadcast(false, TEXT("Failed to parse auth response"));
        return;
    }

    FString Token;
    if (!Json->TryGetStringField(TEXT("token"), Token))
    {
        OnAuthComplete.Broadcast(false, TEXT("Auth response missing 'token'"));
        return;
    }

    AuthToken = Token;
    UE_LOG(LogTemp, Log, TEXT("[ZeroGSaveSystem] Authenticated successfully"));
    OnAuthComplete.Broadcast(true, TEXT(""));
}

void UZeroGSaveSystem::OnUploadResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnSaveUploadComplete.Broadcast(false, TEXT(""), -1, TEXT("Network error on upload"));
        return;
    }

    if (Response->GetResponseCode() != 201)
    {
        TSharedPtr<FJsonObject> Json;
        TSharedRef<TJsonReader<>> Reader =
            TJsonReaderFactory<>::Create(Response->GetContentAsString());
        FString ErrMsg = TEXT("Upload failed");
        if (FJsonSerializer::Deserialize(Reader, Json))
        {
            Json->TryGetStringField(TEXT("error"), ErrMsg);
        }
        OnSaveUploadComplete.Broadcast(false, TEXT(""), -1, ErrMsg);
        return;
    }

    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnSaveUploadComplete.Broadcast(false, TEXT(""), -1, TEXT("Failed to parse upload response"));
        return;
    }

    FString RootHash;
    int32 Version = -1;
    FString ComputeStatus;
    FString ComputeVerdict;
    float ComputeConfidence = 0.f;
    bool bTeeVerified = false;

    Json->TryGetStringField(TEXT("rootHash"), RootHash);
    Json->TryGetNumberField(TEXT("version"), Version);
    Json->TryGetStringField(TEXT("computeStatus"), ComputeStatus);
    Json->TryGetStringField(TEXT("computeVerdict"), ComputeVerdict);
    Json->TryGetBoolField(TEXT("teeVerified"), bTeeVerified);

    // Parse confidence as number
    double ConfidenceDouble = 0.0;
    Json->TryGetNumberField(TEXT("computeConfidence"), ConfidenceDouble);
    ComputeConfidence = static_cast<float>(ConfidenceDouble);

    // Update cached compute result for Blueprint access
    CachedComputeResult.ComputeStatus = ComputeStatus;
    CachedComputeResult.Verdict = ComputeVerdict;
    CachedComputeResult.Confidence = ComputeConfidence;
    CachedComputeResult.bTeeVerified = bTeeVerified;
    CachedComputeResult.bAccepted = !ComputeVerdict.Equals(TEXT("REJECTED"), ESearchCase::CaseSensitive);

    UE_LOG(LogTemp, Log,
        TEXT("[ZeroGSaveSystem] Save uploaded — rootHash=%s version=%d compute=%s verdict=%s tee=%d"),
        *RootHash, Version, *ComputeStatus, *ComputeVerdict, bTeeVerified
    );

    // Fire compute delegate if validation was run
    if (!ComputeStatus.IsEmpty() && !ComputeStatus.Equals(TEXT("skipped"), ESearchCase::IgnoreCase))
    {
        OnComputeValidationComplete.Broadcast(
            CachedComputeResult.bAccepted,
            ComputeVerdict,
            ComputeConfidence,
            bTeeVerified,
            TEXT("")
        );
    }

    OnSaveUploadComplete.Broadcast(true, RootHash, Version, TEXT(""));
}

void UZeroGSaveSystem::OnDownloadMetadataResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected,
    int32 RequestedVersion
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnSaveDownloadComplete.Broadcast(false, -1, TEXT("Network error fetching metadata"));
        return;
    }

    if (Response->GetResponseCode() == 404)
    {
        // No remote save — first-time player on this device; proceed with local
        OnSaveDownloadComplete.Broadcast(true, 0, TEXT("No remote save found"));
        return;
    }

    if (Response->GetResponseCode() != 200)
    {
        OnSaveDownloadComplete.Broadcast(
            false, -1,
            FString::Printf(TEXT("Metadata fetch failed (%d)"), Response->GetResponseCode())
        );
        return;
    }

    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnSaveDownloadComplete.Broadcast(false, -1, TEXT("Failed to parse metadata"));
        return;
    }

    int32 Version = 0;
    FString RootHash, Checksum, DAStatus;
    Json->TryGetNumberField(TEXT("version"), Version);
    Json->TryGetStringField(TEXT("rootHash"), RootHash);
    Json->TryGetStringField(TEXT("checksum"), Checksum);
    Json->TryGetStringField(TEXT("daStatus"), DAStatus);

    // Populate cached metadata for Blueprint access
    CachedMetadata.Version  = Version;
    CachedMetadata.RootHash = RootHash;
    CachedMetadata.Checksum = Checksum;
    CachedMetadata.DAStatus = DAStatus;

    UE_LOG(LogTemp, Log,
        TEXT("[ZeroGSaveSystem] Remote save v%d found (rootHash=%s, DA=%s)"),
        Version, *RootHash, *DAStatus
    );

    // Step 2: Download the actual binary
    FString DownloadEndpoint = (RequestedVersion > 0)
        ? FString::Printf(TEXT("/save/download?version=%d"), RequestedVersion)
        : TEXT("/save/download");

    auto DlRequest = MakeRequest(TEXT("GET"), DownloadEndpoint);
    DlRequest->OnProcessRequestComplete().BindUObject(
        this, &UZeroGSaveSystem::OnDownloadBinaryResponse, Version
    );
    DlRequest->ProcessRequest();
}

void UZeroGSaveSystem::OnDownloadBinaryResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected,
    int32 Version
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnSaveDownloadComplete.Broadcast(false, -1, TEXT("Network error downloading save"));
        return;
    }

    if (Response->GetResponseCode() != 200)
    {
        OnSaveDownloadComplete.Broadcast(
            false, -1,
            FString::Printf(TEXT("Download failed (%d)"), Response->GetResponseCode())
        );
        return;
    }

    if (!WriteResponseToSavSlot(Response))
    {
        OnSaveDownloadComplete.Broadcast(false, -1, TEXT("Failed to write save to disk"));
        return;
    }

    // Verify the downloaded file's SHA-256 against the X-Checksum header
    FString ExpectedChecksum = Response->GetHeader(TEXT("X-Checksum"));
    if (!ExpectedChecksum.IsEmpty())
    {
        TArray<uint8> Written;
        FFileHelper::LoadFileToArray(Written, *GetLocalSavePath());
        FString ActualChecksum = ComputeSHA256(Written);

        if (!ActualChecksum.Equals(ExpectedChecksum, ESearchCase::IgnoreCase))
        {
            UE_LOG(LogTemp, Error,
                TEXT("[ZeroGSaveSystem] Checksum mismatch! Expected=%s Got=%s"),
                *ExpectedChecksum, *ActualChecksum
            );
            OnSaveDownloadComplete.Broadcast(
                false, -1,
                TEXT("Integrity check failed: checksum mismatch")
            );
            return;
        }
    }

    UE_LOG(LogTemp, Log, TEXT("[ZeroGSaveSystem] Save v%d downloaded and verified"), Version);
    OnSaveDownloadComplete.Broadcast(true, Version, TEXT(""));
}

void UZeroGSaveSystem::OnVerifyResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnVerifyComplete.Broadcast(false, TEXT("UNVERIFIED"), TEXT("Network error"));
        return;
    }

    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnVerifyComplete.Broadcast(false, TEXT("UNVERIFIED"), TEXT("Parse error"));
        return;
    }

    FString Verdict;
    Json->TryGetStringField(TEXT("verdict"), Verdict);

    bool bClean = Verdict.Equals(TEXT("CLEAN"), ESearchCase::CaseSensitive);
    OnVerifyComplete.Broadcast(bClean, Verdict, TEXT(""));
}

void UZeroGSaveSystem::OnComputeValidationResponse(
    FHttpRequestPtr Request,
    FHttpResponsePtr Response,
    bool bConnected
)
{
    if (!bConnected || !Response.IsValid())
    {
        OnComputeValidationComplete.Broadcast(
            false, TEXT("UNVERIFIED"), 0.f, false,
            TEXT("Network error during compute validation")
        );
        return;
    }

    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader =
        TJsonReaderFactory<>::Create(Response->GetContentAsString());

    if (!FJsonSerializer::Deserialize(Reader, Json))
    {
        OnComputeValidationComplete.Broadcast(
            false, TEXT("UNVERIFIED"), 0.f, false,
            TEXT("Failed to parse compute response")
        );
        return;
    }

    FString Verdict;
    bool bTeeVerified  = false;
    bool bTeeIndep     = false;
    double Confidence  = 0.0;

    Json->TryGetStringField(TEXT("verdict"), Verdict);
    Json->TryGetBoolField(TEXT("computeTeeVerified"), bTeeVerified);
    Json->TryGetBoolField(TEXT("computeIndependentlyVerified"), bTeeIndep);

    // Extract confidence from nested computeValidation object
    const TSharedPtr<FJsonObject>* ComputeObj = nullptr;
    if (Json->TryGetObjectField(TEXT("computeValidation"), ComputeObj) && ComputeObj)
    {
        (*ComputeObj)->TryGetNumberField(TEXT("confidence"), Confidence);
    }

    bool bAccepted = Verdict.Equals(TEXT("CLEAN"), ESearchCase::CaseSensitive);

    CachedComputeResult.bAccepted = bAccepted;
    CachedComputeResult.Verdict   = Verdict;
    CachedComputeResult.Confidence = static_cast<float>(Confidence);
    CachedComputeResult.bTeeVerified = bTeeVerified;

    UE_LOG(LogTemp, Log,
        TEXT("[ZeroGSaveSystem] Compute validation: verdict=%s tee=%d indep=%d confidence=%.2f"),
        *Verdict, bTeeVerified, bTeeIndep, Confidence
    );

    OnComputeValidationComplete.Broadcast(
        bAccepted, Verdict, static_cast<float>(Confidence), bTeeVerified, TEXT("")
    );
}

// ── Internals ────────────────────────────────────────────────────────────────────

bool UZeroGSaveSystem::WriteResponseToSavSlot(FHttpResponsePtr Response) const
{
    const TArray<uint8>& Content = Response->GetContent();
    if (Content.Num() == 0) return false;

    const FString SavePath = GetLocalSavePath();

    // Ensure the directory exists
    FString Dir = FPaths::GetPath(SavePath);
    IPlatformFile& PF = FPlatformFileManager::Get().GetPlatformFile();
    PF.CreateDirectoryTree(*Dir);

    return FFileHelper::SaveArrayToFile(Content, *SavePath);
}

FString UZeroGSaveSystem::ComputeSHA256(const TArray<uint8>& Data) const
{
    FSHA256HasherContext Hasher;
    Hasher.Update(Data.GetData(), Data.Num());
    FSHAHash Hash;
    Hasher.Final();
    Hasher.GetHash(Hash.Hash);
    return Hash.ToString().ToLower();
}
