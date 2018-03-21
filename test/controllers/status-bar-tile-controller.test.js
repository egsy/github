import fs from 'fs';
import path from 'path';

import React from 'react';
import until from 'test-until';
import {mount} from 'enzyme';

import {cloneRepository, buildRepository, buildRepositoryWithPipeline, setUpLocalAndRemoteRepositories} from '../helpers';
import {getTempDir} from '../../lib/helpers';
import Repository from '../../lib/models/repository';
import StatusBarTileController from '../../lib/controllers/status-bar-tile-controller';
import BranchView from '../../lib/views/branch-view';
import ChangedFilesCountView from '../../lib/views/changed-files-count-view';

describe('StatusBarTileController', function() {
  let atomEnvironment;
  let workspace, workspaceElement, commandRegistry, notificationManager, tooltips, confirm;
  let component;

  beforeEach(function() {
    atomEnvironment = global.buildAtomEnvironment();
    workspace = atomEnvironment.workspace;
    commandRegistry = atomEnvironment.commands;
    notificationManager = atomEnvironment.notifications;
    tooltips = atomEnvironment.tooltips;
    confirm = sinon.stub(atomEnvironment, 'confirm');

    workspaceElement = atomEnvironment.views.getView(workspace);

    component = (
      <StatusBarTileController
        workspace={workspace}
        commandRegistry={commandRegistry}
        notificationManager={notificationManager}
        tooltips={tooltips}
        confirm={confirm}
        ensureGitTabVisible={() => {}}
      />
    );
  });

  afterEach(function() {
    atomEnvironment.destroy();
  });

  function getTooltipNode(wrapper, selector) {
    const ts = tooltips.findTooltips(wrapper.find(selector).node.element);
    assert.lengthOf(ts, 1);
    ts[0].show();
    return ts[0].getTooltipElement();
  }

  describe('branches', function() {
    it('indicates the current branch', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);

      const wrapper = mount(React.cloneElement(component, {repository}));
      await wrapper.instance().refreshModelData();

      assert.equal(wrapper.find(BranchView).prop('currentBranch').name, 'master');
      assert.lengthOf(wrapper.find(BranchView).find('.github-branch-detached'), 0);
    });

    it('styles a detached HEAD differently', async function() {
      const workdirPath = await cloneRepository('multiple-commits');
      const repository = await buildRepository(workdirPath);
      await repository.checkout('HEAD~2');

      const wrapper = mount(React.cloneElement(component, {repository}));
      await wrapper.instance().refreshModelData();

      assert.equal(wrapper.find(BranchView).prop('currentBranch').name, 'master~2');
      assert.lengthOf(wrapper.find(BranchView).find('.github-branch-detached'), 1);
    });

    describe('the branch menu', function() {
      function selectOption(tip, value) {
        const selects = Array.from(tip.getElementsByTagName('select'));
        assert.lengthOf(selects, 1);
        const select = selects[0];
        select.value = value;

        const event = new Event('change', {bubbles: true, cancelable: true});
        select.dispatchEvent(event);
      }

      describe('checking out an existing branch', function() {
        it('can check out existing branches with no conflicts', async function() {
          const workdirPath = await cloneRepository('three-files');
          const repository = await buildRepository(workdirPath);

          // create branch called 'branch'
          await repository.git.exec(['branch', 'branch']);

          const wrapper = mount(React.cloneElement(component, {repository}));
          await wrapper.instance().refreshModelData();

          const tip = getTooltipNode(wrapper, BranchView);
          const selectList = tip.querySelector('select');

          const branches = Array.from(tip.getElementsByTagName('option'), e => e.innerHTML);
          assert.deepEqual(branches, ['branch', 'master']);

          const branch0 = await repository.getCurrentBranch();
          assert.equal(branch0.getName(), 'master');
          assert.isFalse(branch0.isDetached());
          assert.equal(selectList.value, 'master');

          selectOption(tip, 'branch');
          assert.isTrue(selectList.hasAttribute('disabled'));

          await until(async () => {
            const branch1 = await repository.getCurrentBranch();
            return branch1.getName() === 'branch' && !branch1.isDetached();
          });
          await assert.async.equal(selectList.value, 'branch');
          await assert.async.isFalse(selectList.hasAttribute('disabled'));

          selectOption(tip, 'master');
          assert.isTrue(selectList.hasAttribute('disabled'));

          await until(async () => {
            const branch2 = await repository.getCurrentBranch();
            return branch2.getName() === 'master' && !branch2.isDetached();
          });
          await assert.async.equal(selectList.value, 'master');
          await assert.async.isFalse(selectList.hasAttribute('disabled'));
        });

        it('displays an error message if checkout fails', async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories('three-files');
          const repository = await buildRepositoryWithPipeline(localRepoPath, {confirm, notificationManager, workspace});
          await repository.git.exec(['branch', 'branch']);

          // create a conflict
          fs.writeFileSync(path.join(localRepoPath, 'a.txt'), 'a change');

          await repository.git.exec(['commit', '-a', '-m', 'change on master']);
          await repository.checkout('branch');
          fs.writeFileSync(path.join(localRepoPath, 'a.txt'), 'a change that conflicts');

          const wrapper = mount(React.cloneElement(component, {repository}));
          await wrapper.instance().refreshModelData();

          const tip = getTooltipNode(wrapper, BranchView);
          const selectList = tip.querySelector('select');

          const branch0 = await repository.getCurrentBranch();
          assert.equal(branch0.getName(), 'branch');
          assert.isFalse(branch0.isDetached());
          assert.equal(selectList.value, 'branch');

          sinon.stub(notificationManager, 'addError');

          selectOption(tip, 'master');
          assert.isTrue(selectList.hasAttribute('disabled'));
          await assert.async.equal(selectList.value, 'master');
          await until(async () => {
            await wrapper.instance().refreshModelData();
            return selectList.value === 'branch';
          });

          assert.isTrue(notificationManager.addError.called);
          assert.isFalse(selectList.hasAttribute('disabled'));
          const notificationArgs = notificationManager.addError.args[0];
          assert.equal(notificationArgs[0], 'Checkout aborted');
          assert.match(notificationArgs[1].description, /Local changes to the following would be overwritten/);
        });
      });

      describe('checking out newly created branches', function() {
        it('can check out newly created branches', async function() {
          const workdirPath = await cloneRepository('three-files');
          const repository = await buildRepositoryWithPipeline(workdirPath, {confirm, notificationManager, workspace});

          const wrapper = mount(React.cloneElement(component, {repository}));
          await wrapper.instance().refreshModelData();

          const tip = getTooltipNode(wrapper, BranchView);
          const selectList = tip.querySelector('select');
          const editor = tip.querySelector('atom-text-editor');

          const branches = Array.from(tip.querySelectorAll('option'), option => option.value);
          assert.deepEqual(branches, ['master']);
          const branch0 = await repository.getCurrentBranch();
          assert.equal(branch0.getName(), 'master');
          assert.isFalse(branch0.isDetached());
          assert.equal(selectList.value, 'master');

          tip.querySelector('button').click();

          assert.isTrue(selectList.className.includes('hidden'));
          assert.isFalse(tip.querySelector('.github-BranchMenuView-editor').className.includes('hidden'));

          tip.querySelector('atom-text-editor').innerText = 'new-branch';
          tip.querySelector('button').click();
          assert.isTrue(editor.hasAttribute('readonly'));

          await until(async () => {
            const branch1 = await repository.getCurrentBranch();
            return branch1.getName() === 'new-branch' && !branch1.isDetached();
          });
          repository.refresh(); // clear cache manually, since we're not listening for file system events here
          await assert.async.equal(selectList.value, 'new-branch');

          await assert.async.isTrue(tip.querySelector('.github-BranchMenuView-editor').className.includes('hidden'));
          assert.isFalse(selectList.className.includes('hidden'));
        });

        it('displays an error message if branch already exists', async function() {
          const workdirPath = await cloneRepository('three-files');
          const repository = await buildRepositoryWithPipeline(workdirPath, {confirm, notificationManager, workspace});
          await repository.git.exec(['checkout', '-b', 'branch']);

          const wrapper = mount(React.cloneElement(component, {repository}));
          await wrapper.instance().refreshModelData();

          const tip = getTooltipNode(wrapper, BranchView);
          const createNewButton = tip.querySelector('button');
          sinon.stub(notificationManager, 'addError');

          const branches = Array.from(tip.getElementsByTagName('option'), option => option.value);
          assert.deepEqual(branches, ['branch', 'master']);
          const branch0 = await repository.getCurrentBranch();
          assert.equal(branch0.getName(), 'branch');
          assert.isFalse(branch0.isDetached());
          assert.equal(tip.querySelector('select').value, 'branch');

          createNewButton.click();
          tip.querySelector('atom-text-editor').innerText = 'master';
          createNewButton.click();
          assert.isTrue(createNewButton.hasAttribute('disabled'));

          await assert.async.isTrue(notificationManager.addError.called);
          const notificationArgs = notificationManager.addError.args[0];
          assert.equal(notificationArgs[0], 'Cannot create branch');
          assert.match(notificationArgs[1].description, /already exists/);

          const branch1 = await repository.getCurrentBranch();
          assert.equal(branch1.getName(), 'branch');
          assert.isFalse(branch1.isDetached());

          assert.lengthOf(tip.querySelectorAll('.github-BranchMenuView-editor'), 1);
          assert.equal(tip.querySelector('atom-text-editor').innerText, 'master');
          assert.isFalse(createNewButton.hasAttribute('disabled'));
        });
      });

      describe('with a detached HEAD', function() {
        it('includes the current describe output as a disabled option', async function() {
          const workdirPath = await cloneRepository('multiple-commits');
          const repository = await buildRepository(workdirPath);
          await repository.checkout('HEAD~2');

          const wrapper = mount(React.cloneElement(component, {repository}));
          await wrapper.instance().refreshModelData();

          const tip = getTooltipNode(wrapper, BranchView);
          assert.equal(tip.querySelector('select').value, 'detached');
          const option = tip.querySelector('option[value="detached"]');
          assert.equal(option.textContent, 'master~2');
          assert.isTrue(option.disabled);
        });
      });
    });
  });

  describe('pushing and pulling', function() {

    describe('status bar tile state', function() {

      describe('when there is no remote tracking branch', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.git.exec(['checkout', '-b', 'new-branch']);

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives the option to publish the current branch', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'Publish');
        });

        it('pushes the current branch when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isTrue(repository.push.called);
        });

        it('does nothing when clicked and currently pushing', function() {
          repository.getOperationStates().setPushInProgress(true);
          statusBarTile = mount(React.cloneElement(component, {repository}));

          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is a remote with nothing to pull or push', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives the option to fetch from remote', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'Fetch');
        });

        it('fetches from remote when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isTrue(repository.fetch.called);
        });

        it('does nothing when clicked and currently fetching', function() {
          repository.getOperationStates().setFetchInProgress(true);
          statusBarTile = mount(React.cloneElement(component, {repository}));

          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is a remote and we are ahead', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.git.commit('new local commit', {allowEmpty: true});

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives the option to push with ahead count', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'Push 1');
        });

        it('pushes when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isTrue(repository.push.called);
        });

        it('does nothing when clicked and is currently pushing', function() {
          repository.getOperationStates().setPushInProgress(true);
          statusBarTile = mount(React.cloneElement(component, {repository}));

          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is a remote and we are behind', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.git.exec(['reset', '--hard', 'HEAD~2']);

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives the option to pull with behind count', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'Pull 2');
        });

        it('pulls when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isTrue(repository.pull.called);
        });

        it('does nothing when clicked and is currently pulling', function() {
          repository.getOperationStates().setPullInProgress(true);
          statusBarTile = mount(React.cloneElement(component, {repository}));

          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is a remote and we are ahead and behind', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.git.exec(['reset', '--hard', 'HEAD~2']);
          await repository.git.commit('new local commit', {allowEmpty: true});

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives the option to pull with ahead and behind count', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), '1 Pull 2');
        });

        it('pulls when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isTrue(repository.pull.called);
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
        });

        it('does nothing when clicked and is currently pulling', function() {
          repository.getOperationStates().setPullInProgress(true);
          statusBarTile = mount(React.cloneElement(component, {repository}));

          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is a remote and we are detached HEAD', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.checkout('HEAD~2');

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives a hint that we are not on a branch', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'Not on branch');
        });

        it('does nothing when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

      describe('when there is no remote named "origin"', function() {
        let repository;
        let statusBarTile;

        beforeEach(async function() {
          const {localRepoPath} = await setUpLocalAndRemoteRepositories();
          repository = await buildRepository(localRepoPath);
          await repository.git.exec(['remote', 'remove', 'origin']);

          statusBarTile = mount(React.cloneElement(component, {repository}));
          await statusBarTile.instance().refreshModelData();

          sinon.spy(repository, 'fetch');
          sinon.spy(repository, 'push');
          sinon.spy(repository, 'pull');
        });

        it('gives that there is no remote', function() {
          assert.equal(statusBarTile.find('.github-PushPull').text().trim(), 'No remote');
        });

        it('does nothing when clicked', function() {
          statusBarTile.find('.push-pull-target').simulate('click');
          assert.isFalse(repository.fetch.called);
          assert.isFalse(repository.push.called);
          assert.isFalse(repository.pull.called);
        });
      });

    });

    it('displays an error message if push fails', async function() {
      const {localRepoPath} = await setUpLocalAndRemoteRepositories();
      const repository = await buildRepositoryWithPipeline(localRepoPath, {confirm, notificationManager, workspace});
      await repository.git.exec(['reset', '--hard', 'HEAD~2']);
      await repository.git.commit('another commit', {allowEmpty: true});

      const wrapper = mount(React.cloneElement(component, {repository}));
      await wrapper.instance().refreshModelData();

      sinon.stub(notificationManager, 'addError');

      try {
        await wrapper.instance().getWrappedComponentInstance().push();
      } catch (e) {
        assert(e, 'is error');
      }
      await wrapper.instance().refreshModelData();

      await assert.async.isTrue(notificationManager.addError.called);
      const notificationArgs = notificationManager.addError.args[0];
      assert.equal(notificationArgs[0], 'Push rejected');
      assert.match(notificationArgs[1].description, /Try pulling before pushing/);

      await wrapper.instance().refreshModelData();

      wrapper.unmount();
    });

    describe('fetch and pull commands', function() {
      it('fetches when github:fetch is triggered', async function() {
        const {localRepoPath} = await setUpLocalAndRemoteRepositories('multiple-commits', {remoteAhead: true});
        const repository = await buildRepository(localRepoPath);

        const wrapper = mount(React.cloneElement(component, {repository}));
        await wrapper.instance().refreshModelData();

        sinon.spy(repository, 'fetch');

        commandRegistry.dispatch(workspaceElement, 'github:fetch');

        assert.isTrue(repository.fetch.called);
      });

      it('pulls when github:pull is triggered', async function() {
        const {localRepoPath} = await setUpLocalAndRemoteRepositories('multiple-commits', {remoteAhead: true});
        const repository = await buildRepository(localRepoPath);

        const wrapper = mount(React.cloneElement(component, {repository}));
        await wrapper.instance().refreshModelData();

        sinon.spy(repository, 'pull');

        commandRegistry.dispatch(workspaceElement, 'github:pull');

        assert.isTrue(repository.pull.called);
      });

      it('pushes when github:push is triggered', async function() {
        const {localRepoPath} = await setUpLocalAndRemoteRepositories();
        const repository = await buildRepository(localRepoPath);

        const wrapper = mount(React.cloneElement(component, {repository}));
        await wrapper.instance().refreshModelData();

        sinon.spy(repository, 'push');

        commandRegistry.dispatch(workspaceElement, 'github:push');

        assert.isTrue(repository.push.calledWith('master', sinon.match({force: false, setUpstream: false})));
      });

      it('force pushes when github:force-push is triggered', async function() {
        const {localRepoPath} = await setUpLocalAndRemoteRepositories();
        const repository = await buildRepositoryWithPipeline(localRepoPath, {confirm, notificationManager, workspace});

        confirm.returns(0);
        const wrapper = mount(React.cloneElement(component, {repository}));
        await wrapper.instance().refreshModelData();

        sinon.spy(repository.git, 'push');

        commandRegistry.dispatch(workspaceElement, 'github:force-push');

        assert.equal(confirm.callCount, 1);
        await assert.async.isTrue(repository.git.push.calledWith('origin', 'master', sinon.match({force: true, setUpstream: false})));
        await assert.async.isFalse(repository.getOperationStates().isPushInProgress());
      });

      it('displays a warning notification when pull results in merge conflicts', async function() {
        const {localRepoPath} = await setUpLocalAndRemoteRepositories('multiple-commits', {remoteAhead: true});
        fs.writeFileSync(path.join(localRepoPath, 'file.txt'), 'apple');
        const repository = await buildRepositoryWithPipeline(localRepoPath, {confirm, notificationManager, workspace});
        await repository.git.exec(['commit', '-am', 'Add conflicting change']);

        const wrapper = mount(React.cloneElement(component, {repository}));
        await wrapper.instance().refreshModelData();

        sinon.stub(notificationManager, 'addWarning');

        try {
          await wrapper.instance().getWrappedComponentInstance().pull();
        } catch (e) {
          assert(e, 'is error');
        }
        await wrapper.instance().refreshModelData();

        await assert.async.isTrue(notificationManager.addWarning.called);
        const notificationArgs = notificationManager.addWarning.args[0];
        assert.equal(notificationArgs[0], 'Merge conflicts');
        assert.match(notificationArgs[1].description, /Your local changes conflicted with changes made on the remote branch./);

        assert.isTrue(await repository.isMerging());
      });
    });
  });

  describe('changed files', function() {
    it('shows the changed files count view when the repository data is loaded', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);

      const toggleGitTab = sinon.spy();

      const wrapper = mount(React.cloneElement(component, {repository, toggleGitTab}));
      await wrapper.instance().refreshModelData();

      assert.equal(wrapper.find('.github-ChangedFilesCount').render().text(), '0 files');

      fs.writeFileSync(path.join(workdirPath, 'a.txt'), 'a change\n');
      fs.unlinkSync(path.join(workdirPath, 'b.txt'));

      await repository.stageFiles(['a.txt']);
      repository.refresh();

      await assert.async.equal(wrapper.find('.github-ChangedFilesCount').render().text(), '2 files');
    });

    it('toggles the git panel when clicked', async function() {
      const workdirPath = await cloneRepository('three-files');
      const repository = await buildRepository(workdirPath);

      const toggleGitTab = sinon.spy();

      const wrapper = mount(React.cloneElement(component, {repository, toggleGitTab}));
      await wrapper.instance().refreshModelData();

      wrapper.find(ChangedFilesCountView).simulate('click');
      assert(toggleGitTab.calledOnce);
    });
  });

  describe('while the repository is not present', function() {
    it('does not display the branch or push-pull tiles', async function() {
      const workdirPath = await getTempDir();
      const repository = new Repository(workdirPath);
      assert.isFalse(repository.isPresent());

      const wrapper = mount(React.cloneElement(component, {repository}));

      assert.isFalse(wrapper.find('BranchView').exists());
      assert.isFalse(wrapper.find('BranchMenuView').exists());
      assert.isFalse(wrapper.find('PushPullView').exists());
      assert.isTrue(wrapper.find('ChangedFilesCountView').exists());
    });
  });
});
