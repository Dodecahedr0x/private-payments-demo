import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PrivatePayments } from "../target/types/private_payments";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  PERMISSION_PROGRAM_ID,
  PERMISSION_SEED,
  GROUP_SEED,
} from "../app/src/constants";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintToChecked,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { Transaction } from "@solana/web3.js";
import { SystemProgram } from "@solana/web3.js";

describe("private-payments", () => {
  const userKp = Keypair.generate();
  const wallet = new anchor.Wallet(userKp);
  const otherUserKp = Keypair.generate();

  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection("http://localhost:8899", {
      wsEndpoint: "ws://localhost:8900",
    }),
    wallet
  );
  const ephemeralProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection("http://localhost:7799", {
      wsEndpoint: "ws://localhost:7800",
    }),
    wallet
  );
  anchor.setProvider(provider);

  const program = new Program<PrivatePayments>(
    anchor.workspace.privatePayments.idl,
    provider
  );
  const ephemeralProgram = new Program<PrivatePayments>(
    anchor.workspace.privatePayments.idl,
    ephemeralProvider
  );
  const user = userKp.publicKey;
  const otherUser = otherUserKp.publicKey;
  let tokenMint: PublicKey,
    userTokenAccount: PublicKey,
    depositTokenAccount: PublicKey;
  const initialAmount = 1000000;
  const groupId = PublicKey.unique();
  const otherGroupId = PublicKey.unique();
  let depositPda: PublicKey, otherDepositPda: PublicKey;

  before(async () => {
    console.log("Airdropping", user.toBase58(), otherUser.toBase58());
    const faucet = anchor.Wallet.local();

    for (const kp of [userKp, otherUserKp]) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: faucet.publicKey,
          toPubkey: kp.publicKey,
          lamports: LAMPORTS_PER_SOL,
        })
      );
      tx.recentBlockhash = (
        await provider.connection.getLatestBlockhash()
      ).blockhash;
      tx.feePayer = faucet.publicKey;
      let signedTx = await faucet.signTransaction(tx);
      let rawTx = signedTx.serialize();
      let sig = await provider.connection.sendRawTransaction(rawTx);
      await provider.connection.confirmTransaction(sig);
    }
    // await provider.connection.requestAirdrop(
    //   userKp.publicKey,
    //   100 * LAMPORTS_PER_SOL
    // );
    // await provider.connection.requestAirdrop(
    //   otherUserKp.publicKey,
    //   10 * LAMPORTS_PER_SOL
    // );

    let balance = await provider.connection.getBalance(userKp.publicKey);
    console.log("Balance", balance);
    while (balance === 0) {
      console.log("Airdropping...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      balance = await provider.connection.getBalance(userKp.publicKey);
    }
    if (balance === 0) throw new Error("airdrop failed...");

    console.log("Creating mint");
    tokenMint = await createMint(provider.connection, userKp, user, null, 6);

    depositPda = PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), user.toBuffer(), tokenMint.toBuffer()],
      program.programId
    )[0];
    otherDepositPda = PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), otherUser.toBuffer(), tokenMint.toBuffer()],
      program.programId
    )[0];

    console.log("Creating associated token account");
    userTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      userKp,
      tokenMint,
      user
    );
    console.log("Getting associated token address");
    depositTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      userKp,
      tokenMint,
      depositPda,
      undefined,
      TOKEN_PROGRAM_ID,
      undefined,
      true
    );

    console.log("Minting to associated token account");
    await mintToChecked(
      provider.connection,
      userKp,
      tokenMint,
      userTokenAccount,
      user,
      new anchor.BN(initialAmount) as any,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
  });

  it("Deposits initialized", async () => {
    await program.methods
      .initializeDeposit()
      .accountsPartial({
        user,
        deposit: depositPda,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });
    await program.account.deposit.fetch(depositPda);

    await program.methods
      .initializeDeposit()
      .accountsPartial({
        payer: user,
        user: otherUser,
        deposit: otherDepositPda,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([otherUserKp])
      .rpc({ skipPreflight: true });
    await program.account.deposit.fetch(otherDepositPda);
  });

  it("Modify balance", async () => {
    await program.methods
      .modifyBalance({
        amount: new anchor.BN(initialAmount / 2),
        increase: true,
      })
      .accountsPartial({
        payer: user,
        user,
        deposit: depositPda,
        userTokenAccount,
        depositTokenAccount,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKp])
      .rpc({ skipPreflight: true });

    let deposit = await program.account.deposit.fetch(depositPda);
    assert.equal(deposit.amount.toNumber(), initialAmount / 2);

    await program.methods
      .modifyBalance({
        amount: new anchor.BN(initialAmount / 4),
        increase: false,
      })
      .accountsPartial({
        user,
        deposit: depositPda,
        userTokenAccount,
        depositTokenAccount,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });
    deposit = await program.account.deposit.fetch(depositPda);
    assert.equal(deposit.amount.toNumber(), initialAmount / 4);

    await program.methods
      .modifyBalance({
        amount: new anchor.BN((3 * initialAmount) / 4),
        increase: true,
      })
      .accountsPartial({
        user,
        deposit: depositPda,
        userTokenAccount,
        depositTokenAccount,
        tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });
    deposit = await program.account.deposit.fetch(depositPda);
    assert.equal(deposit.amount.toNumber(), initialAmount);
  });

  it("Create permission", async () => {
    for (const { deposit, kp, id } of [
      { deposit: depositPda, kp: userKp, id: groupId },
      { deposit: otherDepositPda, kp: otherUserKp, id: otherGroupId },
    ]) {
      const permission = PublicKey.findProgramAddressSync(
        [PERMISSION_SEED, deposit.toBuffer()],
        PERMISSION_PROGRAM_ID
      )[0];
      const group = PublicKey.findProgramAddressSync(
        [GROUP_SEED, id.toBuffer()],
        PERMISSION_PROGRAM_ID
      )[0];

      await program.methods
        .createPermission(id)
        .accountsPartial({
          payer: user,
          user: kp.publicKey,
          deposit,
          permission,
          group,
          permissionProgram: PERMISSION_PROGRAM_ID,
        })
        .signers([kp])
        .rpc({ skipPreflight: true });
    }
  });

  it("Delegate", async () => {
    for (const { deposit, kp } of [
      { deposit: depositPda, kp: userKp },
      { deposit: otherDepositPda, kp: otherUserKp },
    ]) {
      const tx = await program.methods
        .delegate(kp.publicKey, tokenMint)
        .accountsPartial({ payer: kp.publicKey, deposit })
        .signers([kp])
        .rpc({ skipPreflight: true });
      console.log("Your transaction signature", tx);
    }
  });

  it("Transfer", async () => {
    // Used to force fetching accounts from the base validator
    await ephemeralProvider.connection.requestAirdrop(depositPda, 1000);
    await ephemeralProvider.connection.requestAirdrop(otherDepositPda, 1000);

    ephemeralProgram.methods
      .transferDeposit(new anchor.BN(initialAmount / 2))
      .accountsPartial({
        user,
        sourceDeposit: depositPda,
        destinationDeposit: otherDepositPda,
        tokenMint,
      })
      .signers([userKp])
      .rpc({ skipPreflight: true });

    let deposit = await ephemeralProgram.account.deposit.fetch(depositPda);
    assert.equal(deposit.amount.toNumber(), initialAmount / 2);

    deposit = await ephemeralProgram.account.deposit.fetch(otherDepositPda);
    assert.equal(deposit.amount.toNumber(), initialAmount / 2);
  });
});
