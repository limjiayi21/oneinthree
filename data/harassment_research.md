# Street harassment research used by the simulation

Compiled 14 November 2026. The machine-readable copy is `data/harassment_research.json`. The longer evidence table, with every calibration number, stays in `content/evidence.json` and `docs/research/evidence.md`.

Figures below are copied from the linked page. Nothing here is a guess dressed up as a rate. No published study measures how often a street harasser does one particular thing after one particular response from the woman, so those rows say so.

## What he usually does

| Pattern | Figure as printed | Source |
|---|---|---|
| Lifetime street harassment, US women | 65% of women in a 2,000-person nationally representative GfK survey had experienced at least one type. 57% verbal. 41% a physically aggressive form, including sexual touching 23% and following 20%. | [Stop Street Harassment 2014](https://stopstreetharassment.org/wp-content/uploads/2012/08/2014-National-SSH-Street-Harassment-Report.pdf), [study page](https://stopstreetharassment.org/our-work/nationalstudy/2014study/) |
| Who does it | One man was the most common experience for women (70%). 38% of women had been harassed by two or more men. | [Stop Street Harassment 2014](https://stopstreetharassment.org/wp-content/uploads/2012/08/2014-National-SSH-Street-Harassment-Report.pdf) |
| How it sounds, at the non-explicit end | Uninvited greeting, being told to smile, a request for a name or number that continues after a no, honking or whistling. | [Stop Street Harassment 2014](https://stopstreetharassment.org/wp-content/uploads/2012/08/2014-National-SSH-Street-Harassment-Report.pdf) |
| Sexist insult | About 22% of all women had been called a sexist slur such as "bitch" or "slut" in public. | [Stop Street Harassment 2014](https://stopstreetharassment.org/wp-content/uploads/2012/08/2014-National-SSH-Street-Harassment-Report.pdf) |
| Fear it will get worse | 68% of harassed women were very or somewhat concerned the incident would escalate. 25% were very concerned. This is fear, not a count of escalations. | [Stop Street Harassment 2014](https://stopstreetharassment.org/wp-content/uploads/2012/08/2014-National-SSH-Street-Harassment-Report.pdf) |
| International survey | More than 16,600 women answered the 2014 Hollaback! survey led at Cornell. The school's summary of 22 countries says more than half of respondents had been groped or fondled. | [Cornell ILR 2015](https://www.ilr.cornell.edu/news/about-ilr/global-research) |
| Safe Cities | Rabat: 92% of women had experienced some form of sexual harassment in their lifetime. Quito, 2011 scoping study: 68% of women had experienced some form of sexual violence in public spaces in the previous year. Port Moresby: more than half of women market vendors had experienced some form of violence in the markets. | [UN Women 2017](https://www.unwomen.org/sites/default/files/Headquarters/Attachments/Sections/Library/Publications/2017/Safe-Cities-and-Safe-Public-Spaces-Global-results-report-en.pdf) |

## How encounters are described as going

| Her move or the scene | What can be cited | What is not known |
|---|---|---|
| Firm boundary | 31% of all women in the US survey had told a harasser to stop or back off, the most common proactive response. The report says a simple "no", "back off", or "stop harassing me" can be effective. | How often he then leaves, and how often he gets hostile. |
| Ignoring | Focus groups describe men turning angry or insulting after being ignored. | Any rate. |
| Bystander | In 223 New York Hollaback! incidents, bystanders were present in 31%. Where present: positive effect 26%, negative 22%, no action 19%. When a bystander confronted him, harassment was more likely to cease. No percentage is given for that. A knowing look or an empathetic remark could help her. [Cornell and Hollaback! 2012](https://www.ilr.cornell.edu/sites/default/files-d8/ILR_Report_TARGET_1B_11202012_1.pdf). | A rate for "calm no plus bystander". The simulation's rule uses the direction of this finding and does not pretend the size is measured. |
| Filming | Right To Be: record only when someone else is already helping, and let her decide what happens to the footage. | Any rate for how he reacts to a camera. |
| Insult | Focus groups include men answering a refusal with an insult. | The size of any extra risk. |

## The 5Ds

Right To Be (formerly Hollaback!) teaches five ways to intervene. Four are indirect. [The guide](https://righttobe.org/guides/bystander-intervention-training/). The caution on Direct is also summarised by [Rape Crisis England & Wales](https://rapecrisis.org.uk/get-informed/what-to-do-if-you-see-sexual-violence/).

| D | What it is |
|---|---|
| Distract | Ignore him and talk to her about something else, or get in the way. |
| Delegate | Ask a third person, and say what you see and what you want them to do. |
| Document | Record only if someone is already helping and you are safe. She decides what happens to the footage. |
| Delay | Check in afterwards if you could not act in the moment. |
| Direct | One short sentence telling him to stop. The risky one: he may turn on you. Use it when you and she are safe, escalation looks unlikely, and she seems to want someone to speak. |

## How the sim uses this

- The line writer and the ElevenLabs agent receive the short pattern note in `promptBrief`. It has no numbers, so the model cannot recite a statistic it was not given. The stance is still chosen before the line.
- A firm boundary together with a bystander forces him to back off. The rule text names Cornell and Stop Street Harassment and says there is no measured rate.
- The debrief names which of the 5Ds were used and links the guide. A woman's debrief links the 2014 survey and does not claim her choice controlled him.
