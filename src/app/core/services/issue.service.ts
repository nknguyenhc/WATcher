import {Injectable} from '@angular/core';
import {GithubService} from './github.service';
import {map} from 'rxjs/operators';
import {BehaviorSubject, forkJoin, Observable, of} from 'rxjs';
import {
  Issue,
  Issues,
  IssuesFilter,
  LABELS,
  labelsToAttributeMapping,
  phase2DescriptionTemplate,
  phase3DescriptionTemplate, RespondType
} from '../models/issue.model';
import {UserService} from './user.service';
import {Phase, PhaseService} from './phase.service';
import {IssueCommentService} from './issue-comment.service';
import {PermissionService} from './permission.service';
import * as moment from 'moment';
import {Team} from '../models/team.model';
import {DataService} from './data.service';

@Injectable({
  providedIn: 'root',
})
export class IssueService {
  issues: Issues;
  issues$: BehaviorSubject<Issue[]>;

  constructor(private githubService: GithubService,
              private userService: UserService,
              private phaseService: PhaseService,
              private issueCommentService: IssueCommentService,
              private permissionService: PermissionService,
              private dataService: DataService) {
    this.issues$ = new BehaviorSubject(new Array<Issue>());
  }

  /**
   * Will return an Observable with JSON object conforming with the following structure:
   * issues = { [issue.id]: Issue }
   *
   * If the issues have been fetched before, the function will return the existing issues instead of calling from Github API.
   */
  getAllIssues(): Observable<Issue[]> {
    if (this.issues === undefined) {
      return this.initializeData();
    }
    return this.issues$;
  }

  getIssue(id: number): Observable<Issue> {
    if (this.issues === undefined) {
      return this.githubService.fetchIssue(id).pipe(
        map((response) => {
          return this.createIssueModel(response);
        })
      );
    } else {
      return of(this.issues[id]);
    }
  }

  createIssue(title: string, description: string, severity: string, type: string): Observable<Issue> {
    const labelsArray = [this.createLabel('severity', severity), this.createLabel('type', type)];
    return this.githubService.createIssue(title, description, labelsArray).pipe(
      map((response) => {
        return this.createIssueModel(response);
      })
    );
  }

  updateIssue(issue: Issue): Observable<Issue> {
    return this.githubService.updateIssue(issue.id, issue.title, this.createGithubIssueDescription(issue),
      this.createLabelsForIssue(issue), issue.assignees).pipe(
        map((response) => {
          return this.createIssueModel(response);
        })
    );
  }

  // Returns a string that represents the description of the issue as represented in github.
  private createGithubIssueDescription(issue: Issue): string {
    switch (this.phaseService.currentPhase) {
      case Phase.phase2:
        return `# Description\n${issue.description}\n# Team\'s Response\n${issue.teamResponse}\n ` +
          `## State the duplicated issue here, if any\n${issue.duplicateOf ? `Duplicate of #${issue.duplicateOf}` : `--`}`;
      case Phase.phase3:
        if (!issue.todoList) {
          issue.todoList = [];
        }
        let todoString = '';
        for (const todo of issue.todoList) {
          todoString += todo + '\n';
        }
        return `# Description\n${issue.description}\n# Team\'s Response\n${issue.teamResponse}\n ` +
          `## State the duplicated issue here, if any\n${issue.duplicateOf ? `Duplicate of #${issue.duplicateOf}` : `--`}\n` +
          `# Tutor\'s Response\n${issue.tutorResponse}\n## Tutor to check\n${todoString}`;
      default:
        return issue.description;
    }
  }

  deleteIssue(id: number): Observable<Issue> {
    return this.githubService.closeIssue(id).pipe(
      map((response) => {
        return this.createIssueModel(response);
      })
    );
  }

  deleteFromLocalStore(issueToDelete: Issue) {
    const { [issueToDelete.id]: issueToRemove, ...withoutIssueToRemove } = this.issues;
    this.issues = withoutIssueToRemove;
    this.issues$.next(Object.values(this.issues));
  }

  /**
   * To add/update an issue.
   */
  updateLocalStore(issueToUpdate: Issue) {
    this.issues = {
      ...this.issues,
      [issueToUpdate.id]: issueToUpdate,
    };
    this.issues$.next(Object.values(this.issues));
  }

  hasResponse(issueId: number): boolean {
    const responseType = this.phaseService.currentPhase === Phase.phase2 ? RespondType.teamResponse : RespondType.tutorResponse;
    return !!this.issues[issueId][responseType];
  }

  /**
   * Obtain an Observable array of issues that are duplicate of the given issue.
   */
  getDuplicateIssuesFor(parentIssue: Issue): Observable<Issue[]> {
    return this.issues$.pipe(map((issues) => {
      return issues.filter(issue => {
        return issue.duplicateOf === parentIssue.id;
      });
    }));
  }

  reset() {
    this.issues = undefined;
    this.issues$.next(new Array<Issue>());
  }

  private initializeData(): Observable<Issue[]> {
    const filters = [];

    switch (IssuesFilter[this.phaseService.currentPhase][this.userService.currentUser.role]) {
      case 'FILTER_BY_CREATOR':
        filters.push({creator: this.userService.currentUser.loginId});
        break;
      case 'FILTER_BY_TEAM': // Only student has this filter
        const studentTeam = this.userService.currentUser.team.id.split('-');
        filters.push({
          labels: [this.createLabel('tutorial', studentTeam[0]), this.createLabel('team', studentTeam[1])]
        });
        break;
      case 'FILTER_BY_TEAM_ASSIGNED': // Only for Tutors and Admins
        const allocatedTeams = this.userService.currentUser.allocatedTeams;
        for (let i = 0; i < allocatedTeams.length; i++) {
          const labels = [];
          const team = allocatedTeams[i].id.split('-');
          labels.push(this.createLabel('tutorial', team[0]));
          labels.push(this.createLabel('team', team[1]));
          filters.push({ labels: labels });
        }
        break;
      case 'NO_FILTER':
        break;
      case 'NO_ACCESS':
      default:
        return of([]);
    }

    const issuesPerFilter = [];
    if (filters.length === 0) {
      issuesPerFilter.push(this.githubService.fetchIssues({}));
    }
    for (const filter of filters) {
      issuesPerFilter.push(this.githubService.fetchIssues(filter));
    }

    return forkJoin(issuesPerFilter).pipe(
      map((issuesByFilter: [][]) => {
        let mappedResult = {};
        for (const issues of issuesByFilter) {
          for (const issue of issues) {
            const issueModel = this.createIssueModel(issue);
            mappedResult = {
              ...mappedResult,
              [issueModel.id]: issueModel,
            };
          }
        }
        return mappedResult;
      }),
      map((issues: Issues) => {
        this.issues = { ...this.issues, ...issues };
        this.issues = issues;
        this.issues$.next(Object.values(this.issues));
        return Object.values(this.issues);
      })
    );
  }

  private getParsedBody(issue: any) {
    if (this.phaseService.currentPhase === Phase.phase1) {
      return;
    }

    const array = this.parseBody(issue['body']);
    issue.body = array[0];
    issue.teamResponse = array[1];
    issue.duplicateOf = array[2];
    issue.tutorResponse = array[3];
    issue.todoList = array[4];
  }

  private parseBody(body: string): any {
    // tslint:disable-next-line
    const regexExp = this.phaseService.currentPhase == Phase.phase2 ? phase2DescriptionTemplate : phase3DescriptionTemplate;
    const matches = body.match(regexExp);
    regexExp.lastIndex = 0;

    if (matches == null) {
      return Array('', null, null, null, null);
    }

    let description; let teamResponse; let duplicateOf; let tutorResponse; let todoList;

    for (const match of matches) {
      const groups = regexExp.exec(match)['groups'];
      regexExp.lastIndex = 0;
      switch (groups['header']) {
        case '# Description':
          description = groups['description'].trim();
          break;
        case '# Team\'s Response':
          if (groups['description'].trim() === 'Write your response here.') {
            teamResponse = null;
          } else {
            teamResponse = groups['description'].trim();
          }
          break;
        case '## State the duplicated issue here, if any':
          duplicateOf = this.parseDuplicateOfValue(groups['description']);
          break;
        case '# Tutor\'s Response':
          if (groups['description'].trim() === 'Write your response here.') {
            tutorResponse = null;
          } else {
            tutorResponse = groups['description'].trim();
          }
          break;
        case '## Tutor to check':
          todoList = groups['description'].split(/\r?\n/);
          todoList = todoList.filter(function (todo) {
            return todo.trim() !== '';
          });
          break;
        default:
          break;
      }
    }
    return Array(description, teamResponse, duplicateOf, tutorResponse, todoList);
  }

  private createLabelsForIssue(issue: Issue): string[] {
    const result = [];

    if (this.phaseService.currentPhase !== Phase.phase1) {
      const studentTeam = issue.teamAssigned.id.split('-');
      result.push(this.createLabel('tutorial', studentTeam[0]), this.createLabel('team', studentTeam[1]));
    }

    if (issue.severity) {
      result.push(this.createLabel('severity', issue.severity));
    }

    if (issue.type) {
      result.push(this.createLabel('type', issue.type));
    }

    if (issue.responseTag) {
      result.push(this.createLabel('response', issue.responseTag));
    }

    if (issue.duplicated) {
      result.push('duplicate');
    }

    if (issue.status) {
      result.push(this.createLabel('status', issue.status));
    }

    return result;
  }

  private createLabel(prepend: string, value: string) {
    return `${prepend}.${value}`;
  }

  private createIssueModel(issueInJson: {}): Issue {
    this.getParsedBody(issueInJson);
    return <Issue>{
      id: +issueInJson['number'],
      created_at: moment(issueInJson['created_at']).format('lll'),
      title: issueInJson['title'],
      assignees: issueInJson['assignees'].map((assignee) => assignee['login']),
      description: issueInJson['body'],
      teamAssigned: this.getTeamAssignedToIssue(issueInJson),
      todoList: issueInJson['todoList'],
      teamResponse: issueInJson['teamResponse'],
      tutorResponse: issueInJson['tutorResponse'],
      duplicateOf: issueInJson['duplicateOf'],
      ...this.getFormattedLabels(issueInJson['labels'], LABELS),
    };
  }

  getTeamAssignedToIssue(issueInJson: {}): Team {
    if (this.phaseService.currentPhase === Phase.phase1) {
      return null;
    }

    let tutorial = '';
    let team = '';
    issueInJson['labels'].map((label) => {
      const labelName = String(label['name']).split('.');
      const labelType = labelName[0];
      const labelValue = labelName[1];
      if (labelType === 'team') {
        team = labelValue;
      } else if (labelType === 'tutorial') {
        tutorial = labelValue;
      }
    });
    const teamId = `${tutorial}-${team}`;
    return this.dataService.getTeam(teamId);
  }

  private parseDuplicateOfValue(toParse: string): number {
    const regex = /duplicate of\s*#(\d+)/i;
    const result = regex.exec(toParse);
    if (result && result.length >= 2) {
      return +regex.exec(toParse)[1];
    } else {
      return null;
    }
  }


  /**
   * Based on the kind labels specified in `desiredLabels` field, this function will produce a neatly formatted JSON object.
   *
   * For example:
   * desiredLabels = ['severity', 'type']
   * Output = {severity: High, type: FunctionalityBug}
   *
   * TODO: Add error handling for these assumptions.
   * Assumptions:
   * 1) The `labels` which were received from github has all the `desiredLabels` type we want.
   * 2) There are no duplicates for example labels will not contain `severity.High` and `severity.Low` at the same time.
   *
   * @param labels defines the raw label array from which is obtained from github.
   * @param desiredLabels defines the type of labels you want to be parsed out.
   */

  private getFormattedLabels(labels: Array<{}>, desiredLabels: Array<string>): {} {
    let result = {};
    for (const label of labels) {
      const labelName = String(label['name']).split('.');
      const labelType = labelName[0];
      const labelValue = labelName[1];

      if (label['name'] === 'duplicate') {
        result = {
          ...result,
          duplicated: true,
        };
      } else if (desiredLabels.includes(labelType)) {
        result = {
          ...result,
          [labelsToAttributeMapping[labelType]]: labelValue,
        };
      }
    }
    return result;
  }
}
