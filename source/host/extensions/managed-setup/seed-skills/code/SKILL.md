---
name: code
description: >-
  Hand real coding work to a separate throwaway machine instead of doing it by
  hand here. Use when a job is more than a few commands, when it needs a build
  or a test run, or when the only way to know it worked is to run it.
---
# Writing code

When a job is real coding work, you do not have to do it a command at a time in this box. You can hand it to a separate machine that is made for the job, does the work on its own, writes its files, and is thrown away afterwards. Its files land in your own files, so you read them here the ordinary way when it is done.

## When to hand it over

Hand it over when any of these is true:

- it is more than a few commands — a script and its test, several files that have to agree with each other, a refactor;
- the only honest way to know it worked is to run it, build it, or run its tests;
- you would otherwise be writing a long file into a shell command, line by line;
- it will take minutes rather than seconds, and the person is waiting on you for other things in the meantime.

Do it here instead when it is genuinely small: one file, one command, a config line, a rename. Sending a one-liner to another machine is slower than typing it, and it costs the business money.

## How to scope one

A handed-over job gets one set of instructions and cannot ask you a question, so write it the way you would brief a careful engineer who is about to go offline. Three parts, always:

1. **The goal.** What should exist when this is finished, in plain words. Name the files you want written and what each one is for.
2. **What it starts from.** Nothing, or the files you send in. If the job needs something you already have, send those paths; do not describe a file and hope it guesses.
3. **How to check it.** The exact command that proves it worked, and what passing looks like. "Run `python3 -m pytest test_primes.py` and all tests should pass" is a check. "Make sure it works" is not, and a job without one comes back with code nobody has run.

Give it a short title too, in words the person would recognise. The title is the only part of the job shown on their screen, so write it for them: "prime sieve script and its test", not "task 1".

## What the machine has, and what it does not

It has node, python3, git and ripgrep, and whatever files you sent it.

**It has no internet.** That is not a setting somebody forgot; it is deliberate, and it is what makes it safe to run code on. So in this release it cannot:

- clone a repository;
- `npm install`, `pip install`, or fetch a package any other way;
- look anything up, call an API, or download a file.

If a job needs a dependency that is not already there, it cannot be done this way yet. Say that plainly, and offer what you can actually do instead: write the part that needs no dependency, or do the work here where you do have the network.

Every job also has a time limit and a spending limit the operator sets. If it reaches either, it is stopped and you are told so. Say what happened; do not start it again unchanged and hope.

## It does not block the conversation

Starting a job comes back straight away with an id. It has not finished — it has barely begun.

So: tell the person in one line what you sent off, then carry on with whatever else they need. Do not sit and wait for it. Do not poll it over and over; an entry will arrive in this conversation when it is done, and that entry is your cue to go and read it.

## Read the result before you report it

When you are told the job has finished, read its result before you say anything about the work. The result gives you the summary the machine wrote about itself and the list of files it left, and the files are in your own files under `code/` and the job's id — open them with your ordinary read, the way you would open anything else.

The machine's own summary is its account of what it did. It is not proof the work is right, and a job can finish having written something that does not run. So look at what it actually wrote, and if the job had a check, look at whether the check passed.

Then tell the person, in plain words: what it built, where the files are, and whether the check passed. If it did not finish, say that and say why as it was given to you. Never describe work you have not read, and never call a job done because it stopped.

## What you never say

The person never hears the name of a tool, a vendor, or a product this runs on. It is "a separate machine", "a sandbox", or just what it did: "I had the script and its test written, here is where they are."
